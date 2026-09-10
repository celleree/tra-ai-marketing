import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { planCreativeRevision } from '@/lib/ai/creative-revision-planner';
import { generateCreativeRevisionImage } from '@/lib/ai/creative-revision-image';
import { buildCreativeCompanyContext, formatCreativeCompanyContext } from '@/lib/company/creative-context';
import { compositeCreativeBrandLogo } from '@/lib/creatives/brand-logo.server';
import { GeneratedImageValidationError, validateGeneratedCreativeImage } from '@/lib/creatives/generated-image-validation';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { validateCreativeRevisionRequest } from '@/lib/creatives/revision-request';
import { CreativeRevisionHydrationError, hydrateSavedCreativeRevisionContext } from '@/lib/creatives/revision-source-hydration';
import { isSafeCreativeId, listCreatives, saveCreativeBatch } from '@/lib/creatives/storage';
import { getMediaStorage } from '@/lib/media/local-storage';
import type { CreativeRecord } from '@/lib/creatives/generated';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';

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
    const storage = getMediaStorage();
    const sources = await hydrateSavedCreativeRevisionContext(parent, storage);
    const { planning, provenance } = sources.parent;
    const revision = parsed.data;
    const placement = revision.operation === 'PLACEMENT' ? revision.placement : parent.placement!;
    const companyContext = formatCreativeCompanyContext(buildCreativeCompanyContext(revision.companyProfile));
    let concept: PlannedCreativeConcept = {
      index: 1, format: parent.format!, copy: parent.copy, strategy: planning.strategy, selectionReason: planning.selectionReason,
    };
    let plannerModel = planning.model;
    if (revision.operation === 'EDIT' || revision.operation === 'VARIATION') {
      const plan = await planCreativeRevision({
        parent: { format: concept.format, copy: concept.copy, strategy: concept.strategy },
        operation: revision.operation, instruction: revision.instruction, companyContext,
        hasApprovedHumanSource: sources.originalApprovedSource !== null,
      });
      concept = plan.concept;
      plannerModel = plan.plannerModel;
    }
    const id = `creative_${randomUUID().replaceAll('-', '')}`;
    const identity = revision.operation === 'EDIT' || revision.operation === 'VARIATION'
      ? buildCreativeIdentity({ creativeId: id, operation: revision.operation, parent, strategy: concept.strategy })
      : buildCreativeIdentity({ creativeId: id, operation: revision.operation, parent });
    const instruction = 'instruction' in revision ? revision.instruction : undefined;
    const imageResult = await generateCreativeRevisionImage({
      sources, operation: revision.operation, concept: { format: concept.format, copy: concept.copy, strategy: concept.strategy },
      placement, companyContext, ...(instruction ? { instruction } : {}),
    });
    await validateGeneratedCreativeImage(imageResult.buffer, placement);
    const finalBuffer = sources.logoOverlay
      ? await compositeCreativeBrandLogo(imageResult.buffer, sources.logoOverlay.buffer, placement)
      : imageResult.buffer;
    const image = await storage.saveImage(new File([new Uint8Array(finalBuffer)], `tra-revision-${id}.png`, { type: 'image/png' }));
    const record: CreativeRecord = {
      id, createdAt: new Date().toISOString(), image, category: concept.strategy.category,
      format: concept.format, placement, copy: concept.copy, identity,
      planning: { strategy: concept.strategy, selectionReason: concept.selectionReason, model: plannerModel, reasoningEffort: 'medium' },
      generationProvenance: {
        ...provenance, imageGeneration: { prompt: imageResult.prompt, model: imageResult.model, routing: imageResult.routing },
        revision: { parentCreativeId: parentId, canvasMediaId: sources.canvas.mediaId, canvasSha256: sources.canvas.sha256, ...(instruction ? { instruction } : {}) },
      },
      ...(parent.referenceImageId ? { referenceImageId: parent.referenceImageId } : {}),
      ...(parent.videoFrameSelection ? { videoFrameSelection: parent.videoFrameSelection } : {}),
    };
    const [saved] = await saveCreativeBatch([record]);
    return NextResponse.json({ creative: saved }, { status: 201 });
  } catch (error) {
    if (error instanceof CreativeRevisionHydrationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof GeneratedImageValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'Creative revision could not be completed. The saved original is unchanged.' }, { status: 500 });
  }
}
