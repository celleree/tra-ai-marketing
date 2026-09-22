import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { planCreativeRevision } from '@/lib/ai/creative-revision-planner';
import { generateCreativeRevisionImage } from '@/lib/ai/creative-revision-image';
import { buildCreativeCompanyContext, formatCreativeCompanyContext } from '@/lib/company/creative-context';
import { compositeCreativeBrandLogo, eraseCreativeBrandLogo, resolveCreativeBrandLogoPlacementContext } from '@/lib/creatives/brand-logo.server';
import { resolveCreativeLogoGeometry, resolveLayoutAwareLogoAnchor } from '@/lib/creatives/logo-placement';
import { selectedLayout } from '@/lib/references/planning';
import { classifyCreativeCopyContract } from '@/lib/creatives/copy-contract';
import { GeneratedImageValidationError, validateGeneratedCreativeImage } from '@/lib/creatives/generated-image-validation';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { validateCreativeRevisionRequest } from '@/lib/creatives/revision-request';
import { CreativeRevisionHydrationError, hydrateSavedCreativeRevisionContext } from '@/lib/creatives/revision-source-hydration';
import { parseApprovedHumanSourceId } from '@/lib/video/approved-human';
import { requireActiveHumanSelection } from '@/lib/video/approved-human-service';
import { isSafeCreativeId, listCreatives, saveCreativeBatch } from '@/lib/creatives/storage';
import { getMediaStorage } from '@/lib/media/local-storage';
import type { CreativeRecord } from '@/lib/creatives/generated';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import { ProofRevalidationError, revalidateCreativeProofProvenanceForPaidWork, validateCreativeProofCopyConsistency } from '@/lib/proof/provenance';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ creativeId: string }> }) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);

  const { creativeId: parentId } = await context.params;
  if (!isSafeCreativeId(parentId)) return NextResponse.json({ error: 'Invalid creative ID.' }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Revision request must be valid JSON.' }, { status: 400 });
  }
  const parsed = validateCreativeRevisionRequest(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const quotaDenied = await requireOperatorQuota(access.userId, 'CREATIVE_REVISION', 1);
  if (quotaDenied) return quotaDenied;
  try {
    const parent = (await listCreatives()).find(record => record.id === parentId);
    if (!parent) return NextResponse.json({ error: 'Saved creative not found.' }, { status: 404 });
    const parentCopyMode = classifyCreativeCopyContract(parent as unknown as Record<string, unknown>);
    if (parentCopyMode.kind === 'INVALID') {
      throw new CreativeRevisionHydrationError('Saved creative has an invalid separated ad/image copy contract.', 409);
    }
    const proofProvenance = parent.proofProvenance
      ? await revalidateCreativeProofProvenanceForPaidWork(parent.proofProvenance)
      : undefined;
    const storage = getMediaStorage();
    const sources = await hydrateSavedCreativeRevisionContext(parent, storage);
    const { planning, provenance } = sources.parent;
    const revision = parsed.data;
    const placement = revision.operation === 'PLACEMENT' ? revision.placement : parent.placement!;
    const parentLayout = planning.strategy.referenceSelection && planning.referenceCatalog
      ? selectedLayout(planning.strategy.referenceSelection, planning.referenceCatalog)
      : undefined;
    const parentLogoPlacement = sources.logoOverlay
      ? await resolveCreativeBrandLogoPlacementContext(sources.logoOverlay.buffer, parent.placement!)
      : undefined;
    const parentLogoAnchor = sources.logoOverlay
      ? resolveLayoutAwareLogoAnchor(planning.logoAnchor ?? 'top-left', parentLayout, parentLogoPlacement)
      : undefined;
    const companyContext = formatCreativeCompanyContext(buildCreativeCompanyContext(revision.companyProfile));
    let concept: PlannedCreativeConcept = {
      index: 1, format: parent.format!, copy: parentCopyMode.copy,
      ...(parentCopyMode.kind === 'E2' ? { adCopy: parentCopyMode.adCopy, imageCopy: parentCopyMode.imageCopy } : {}),
      ...(parentLogoAnchor ? { logoAnchor: parentLogoAnchor } : {}), strategy: planning.strategy, selectionReason: planning.selectionReason,
    };
    let plannerModel = planning.model;
    if (revision.operation === 'EDIT' || revision.operation === 'VARIATION') {
      const plan = await planCreativeRevision({
        parent: { format: concept.format, copy: concept.copy,
          ...(concept.adCopy ? { adCopy: concept.adCopy } : {}),
          ...(concept.imageCopy ? { imageCopy: concept.imageCopy } : {}),
          ...(concept.logoAnchor ? { logoAnchor: concept.logoAnchor } : {}), strategy: concept.strategy },
        operation: revision.operation, instruction: revision.instruction, companyContext,
        hasApprovedHumanSource: sources.originalApprovedSource !== null,
        hasBrandLogo: sources.logoOverlay !== null,
        ...(parentLogoPlacement ? { logoPlacement: parentLogoPlacement } : {}),
        ...(proofProvenance ? { proofProvenance } : {}),
        ...(planning.referenceCatalog ? { referenceCatalog: planning.referenceCatalog } : {}),
      });
      concept = plan.concept;
      plannerModel = plan.plannerModel;
    }
    if (sources.logoOverlay && !concept.logoAnchor) concept = { ...concept, logoAnchor: parentLogoAnchor! };
    const conceptCopyMode = classifyCreativeCopyContract(concept as unknown as Record<string, unknown>);
    if (conceptCopyMode.kind === 'INVALID') throw new Error('Revision planner returned an invalid separated ad/image copy contract.');
    if (proofProvenance) {
      validateCreativeProofCopyConsistency(proofProvenance, {
        copy: conceptCopyMode.copy,
        ...(conceptCopyMode.kind === 'E2' ? { adCopy: conceptCopyMode.adCopy, imageCopy: conceptCopyMode.imageCopy } : {}),
      });
    }
    const id = `creative_${randomUUID().replaceAll('-', '')}`;
    const instruction = 'instruction' in revision ? revision.instruction : undefined;
    let activeHumanRecordId = concept.strategy.approvedHumanId ?? null;
    if (concept.strategy.humanSourceId) {
      const parsedHumanRecordId = parseApprovedHumanSourceId(concept.strategy.humanSourceId);
      if (!parsedHumanRecordId || activeHumanRecordId) {
        throw new CreativeRevisionHydrationError('The approved human is unavailable.', 409);
      }
      activeHumanRecordId = parsedHumanRecordId;
    }
    if (activeHumanRecordId) {
      try { await requireActiveHumanSelection(activeHumanRecordId, parent.videoFrameSelection); }
      catch (error) { throw new CreativeRevisionHydrationError(error instanceof Error ? error.message : 'The approved human is unavailable.', 409); }
    }
    const identity = revision.operation === 'EDIT' || revision.operation === 'VARIATION'
      ? buildCreativeIdentity({ creativeId: id, operation: revision.operation, parent, strategy: concept.strategy })
      : buildCreativeIdentity({ creativeId: id, operation: revision.operation, parent });
    const removedLibraryHuman = !!(planning.strategy.humanSourceId || planning.strategy.approvedHumanId)
      && concept.strategy.execution.subjectSource === 'non-human';
    const logoPlacement = sources.logoOverlay
      ? placement === parent.placement ? parentLogoPlacement!
        : await resolveCreativeBrandLogoPlacementContext(sources.logoOverlay.buffer, placement)
      : undefined;
    const logoGeometry = logoPlacement && concept.logoAnchor
      ? resolveCreativeLogoGeometry(placement, concept.logoAnchor, logoPlacement.sourceWidth, logoPlacement.sourceHeight)
      : undefined;
    const parentLogoGeometry = parentLogoPlacement && parentLogoAnchor
      ? resolveCreativeLogoGeometry(parent.placement!, parentLogoAnchor,
          parentLogoPlacement.sourceWidth, parentLogoPlacement.sourceHeight)
      : undefined;
    const sourceSelection = removedLibraryHuman ? { ...sources, originalApprovedSource: null } : sources;
    const revisionSources = parentLogoGeometry
      ? { ...sourceSelection, canvas: { ...sourceSelection.canvas,
          buffer: await eraseCreativeBrandLogo(sourceSelection.canvas.buffer, parentLogoGeometry), mimeType: 'image/png' as const } }
      : sourceSelection;
    const imageResult = await generateCreativeRevisionImage({
      sources: revisionSources,
      operation: revision.operation,
      concept: { format: concept.format, copy: conceptCopyMode.copy,
        ...(conceptCopyMode.kind === 'E2' ? { adCopy: conceptCopyMode.adCopy, imageCopy: conceptCopyMode.imageCopy } : {}),
        strategy: concept.strategy },
      placement, companyProfile: revision.companyProfile,
      referenceCatalog: planning.referenceCatalog,
      ...(proofProvenance ? { proofProvenance } : {}),
      ...(logoGeometry ? { logoGeometry } : {}),
    });
    await validateGeneratedCreativeImage(imageResult.buffer, placement);
    const finalBuffer = sources.logoOverlay
      ? await compositeCreativeBrandLogo(imageResult.buffer, sources.logoOverlay.buffer, logoGeometry!)
      : imageResult.buffer;
    const image = await storage.saveImage(new File([new Uint8Array(finalBuffer)], `tra-revision-${id}.png`, { type: 'image/png' }));
    const record: CreativeRecord = {
      id, createdAt: new Date().toISOString(), image, category: concept.strategy.category,
      format: concept.format, placement, copy: conceptCopyMode.copy,
      ...(conceptCopyMode.kind === 'E2' ? { adCopy: conceptCopyMode.adCopy, imageCopy: conceptCopyMode.imageCopy } : {}),
      ...(proofProvenance ? { proofProvenance } : {}),
      identity,
      planning: { strategy: concept.strategy, selectionReason: concept.selectionReason, model: plannerModel, reasoningEffort: 'medium',
        ...(concept.logoAnchor ? { logoAnchor: concept.logoAnchor } : {}),
        ...((revision.operation === 'PLACEMENT' || revision.operation === 'REGENERATE') && planning.portfolioAudit ? { portfolioAudit: planning.portfolioAudit } : {}),
        ...(planning.referenceCatalog ? { referenceCatalog: planning.referenceCatalog } : {}) },
      generationProvenance: {
        ...provenance, imageGeneration: { prompt: imageResult.prompt, model: imageResult.model, routing: imageResult.routing },
        ...(removedLibraryHuman ? { attachedSource: null } : {}),
        revision: { parentCreativeId: parentId, canvasMediaId: sources.canvas.mediaId, canvasSha256: sources.canvas.sha256, ...(instruction ? { instruction } : {}) },
      },
      ...((concept.strategy.referenceSelection ? concept.strategy.referenceSelection.layoutSource : parent.referenceImageId)
        ? { referenceImageId: concept.strategy.referenceSelection?.layoutSource ?? parent.referenceImageId } : {}),
      ...(!removedLibraryHuman && parent.videoFrameSelection ? { videoFrameSelection: parent.videoFrameSelection } : {}),
    };
    const [saved] = await saveCreativeBatch([record]);
    return NextResponse.json({ creative: saved }, { status: 201 });
  } catch (error) {
    if (error instanceof ProofRevalidationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CreativeRevisionHydrationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof GeneratedImageValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'Creative revision could not be completed. The saved original is unchanged.' }, { status: 500 });
  }
}
