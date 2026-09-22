import { createHash, randomUUID } from 'crypto';
import { generatePromptOnlyCreativeImage } from '@/lib/ai/prompt-only-generation';
import { generateApprovedTraReferenceCreativeImage } from '@/lib/ai/openai';
import { generateApprovedTraVideoFrameCreativeImage } from '@/lib/ai/video-frame-generation';
import {
  generateLegacyApprovedTraReferenceCreativeImage,
  generateLegacyApprovedTraVideoFrameCreativeImage,
  generateLegacyPromptOnlyCreativeImage,
} from '@/lib/ai/legacy-copy-image-generation';
import type { SelectedReferenceCreative } from '@/lib/ai/reference-selector';
import type { ImageGenerationResult } from '@/lib/ai/image-generation-result';
import { buildCreativeRenderBrief, formatCreativeRenderBrief } from '@/lib/creatives/render-brief';
import { compositeCreativeBrandLogo, resolveCreativeBrandLogoGeometry } from '@/lib/creatives/brand-logo.server';
import { resolveLayoutAwareLogoAnchor } from '@/lib/creatives/logo-placement';
import { selectedLayout } from '@/lib/references/planning';
import { saveCreativeBatch } from '@/lib/creatives/storage';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { validateGeneratedCreativeImage } from '@/lib/creatives/generated-image-validation';
import { classifyCreativeCopyContract } from '@/lib/creatives/copy-contract';
import type { CreativeAdCopy, CreativeImageCopy, GeneratedCreative } from '@/lib/creatives/generated';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import type { CreativeBatchPlan, PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { MediaStorage } from '@/lib/media/storage';
import type { StoredMediaFile } from '@/lib/media/types';
import type { EligibleProviderImageSource } from '@/lib/media/source-hydration';
import type { ReferencePlanningCandidate } from '@/lib/references/planning';
import { parseApprovedHumanSourceId } from '@/lib/video/approved-human';
import { resolveApprovedHumanFrame } from '@/lib/video/approved-human-service';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import type { ApprovedTraVideoFrame, ApprovedTraVideoFrameSet } from '@/lib/video/types';
import {
  revalidateSelectedProofForPaidWork,
  validateCreativeProofCopyConsistency,
} from '@/lib/proof/provenance';

export type CreativeRenderContext = {
  request: ValidGenerateCreativeRequest;
  batchPlan: Pick<CreativeBatchPlan, 'plannerModel' | 'reasoningEffort' | 'portfolioAudit'>;
  referenceCatalog: ReferencePlanningCandidate[];
  selectedReferences: SelectedReferenceCreative[];
  requestedSources: CreativeGenerationProvenance['requestedSources'];
  analysisSources: CreativeGenerationProvenance['analysisSources'];
  logoOverlaySource?: CreativeGenerationProvenance['logoOverlaySource'];
  reserveLogoArea: boolean;
  brandLogo: StoredMediaFile | null;
  providerImageSource?: EligibleProviderImageSource;
  videoFrameSet: ApprovedTraVideoFrameSet | null;
  generatedVideoFrameSelection?: GeneratedVideoFrameSelection;
  storage: MediaStorage;
};
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

type PlannedCopyMode =
  | { kind: 'LEGACY' }
  | { kind: 'E2'; adCopy: CreativeAdCopy; imageCopy: CreativeImageCopy };

const classifyPlannedCopy = (item: PlannedCreativeConcept): PlannedCopyMode => {
  const contract = classifyCreativeCopyContract(item);
  if (contract.kind === 'LEGACY') return { kind: 'LEGACY' };
  if (contract.kind === 'INVALID') {
    throw new Error('Creative plan has an invalid separated ad/image copy contract and cannot be rendered.');
  }
  return { kind: 'E2', adCopy: contract.adCopy, imageCopy: contract.imageCopy };
};

/** The shared one-ad provider, validation, branding and persistence path. */
export async function renderPlannedCreative(item: PlannedCreativeConcept, {
  request, batchPlan, referenceCatalog, selectedReferences, requestedSources, analysisSources, logoOverlaySource,
  brandLogo, providerImageSource, videoFrameSet, generatedVideoFrameSelection, storage,
}: CreativeRenderContext, options: { creativeId?: string; assertCurrentWork?: () => Promise<void> } = {}): Promise<GeneratedCreative> {
  const creativeId = options.creativeId ?? `creative_${randomUUID().replaceAll('-', '')}`;
  if (!/^creative_[a-f0-9]{32}$/.test(creativeId)) throw new Error('Invalid reserved creative ID.');
  const copyMode = classifyPlannedCopy(item);
  const humanRecordId = item.strategy.humanSourceId
    ? parseApprovedHumanSourceId(item.strategy.humanSourceId)
    : item.strategy.approvedHumanId ?? null;
  if (item.strategy.humanSourceId && !humanRecordId) throw new Error('Unsupported or invalid human source ID.');
  const human = humanRecordId ? await resolveApprovedHumanFrame(humanRecordId) : null;
  const itemVideoFrames = human?.selected ?? videoFrameSet;
  const itemImageSource = human ? null : providerImageSource;
  const itemFrameSelection = human?.record.source ?? generatedVideoFrameSelection;
  const itemRequestedSources = human ? [
    ...requestedSources.filter(source => source.mediaId !== human.record.source.sourceVideoMediaId),
    { role: 'TRA_VIDEO' as const, mediaId: human.record.source.sourceVideoMediaId, sha256: human.record.source.sourceVideoContentHash },
  ] : requestedSources;
  const identity = buildCreativeIdentity({
    creativeId,
    operation: 'GENERATE',
    strategy: item.strategy,
  });
  const copy = item.copy;
  const selectedReference = selectedReferences.find(reference => reference.item.id === item.strategy.referenceSelection?.layoutSource);
  const layoutBlueprint = item.strategy.referenceSelection
    ? selectedLayout(item.strategy.referenceSelection, referenceCatalog)
    : undefined;
  const logoAnchor = brandLogo
    ? resolveLayoutAwareLogoAnchor(item.logoAnchor ?? 'top-left', layoutBlueprint)
    : undefined;
  const logoGeometry = brandLogo && logoAnchor
    ? await resolveCreativeBrandLogoGeometry(brandLogo.buffer, request.placement, logoAnchor)
    : undefined;
  let imageResult: ImageGenerationResult;
  let providerFrames: ApprovedTraVideoFrame[] | undefined;

  await options.assertCurrentWork?.();
  const proofProvenance = await revalidateSelectedProofForPaidWork(item.selectedProof);
  if (proofProvenance) {
    validateCreativeProofCopyConsistency(proofProvenance, {
      copy,
      ...(copyMode.kind === 'E2'
        ? { adCopy: copyMode.adCopy, imageCopy: copyMode.imageCopy }
        : {}),
    });
  }
  const itemContext = formatCreativeRenderBrief(buildCreativeRenderBrief({
    concept: item, companyProfile: request.companyProfile,
    brandColors: request.brandColors, brandFontNames: request.brandFontNames,
    referenceCatalog,
    ...(proofProvenance ? { proofProvenance } : {}),
  }));

  if (itemImageSource) {
    imageResult = copyMode.kind === 'LEGACY'
      ? await generateLegacyApprovedTraReferenceCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          source: itemImageSource.stored,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy,
          logoGeometry,
        })
      : await generateApprovedTraReferenceCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          source: itemImageSource.stored,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy: copyMode.imageCopy,
          logoGeometry,
        });
  } else if (itemVideoFrames) {
    const videoImageResult = copyMode.kind === 'LEGACY'
      ? await generateLegacyApprovedTraVideoFrameCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          frames: itemVideoFrames.frames,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy,
          logoGeometry,
        })
      : await generateApprovedTraVideoFrameCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          frames: itemVideoFrames.frames,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy: copyMode.imageCopy,
          logoGeometry,
        });
    imageResult = videoImageResult;
    providerFrames = videoImageResult.providerFrames;
  } else {
    imageResult = copyMode.kind === 'LEGACY'
      ? await generateLegacyPromptOnlyCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy,
          logoGeometry,
          operationType: item.strategy.referenceSelection?.layoutSource ? 'LAYOUT_REFERENCE_GENERATION' : 'PROMPT_GENERATION',
        })
      : await generatePromptOnlyCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy: copyMode.imageCopy,
          logoGeometry,
          operationType: item.strategy.referenceSelection?.layoutSource ? 'LAYOUT_REFERENCE_GENERATION' : 'PROMPT_GENERATION',
        });
  }

  await validateGeneratedCreativeImage(imageResult.buffer, request.placement);
  const finalImage = brandLogo
    ? await compositeCreativeBrandLogo(imageResult.buffer, brandLogo.buffer, logoGeometry!)
    : imageResult.buffer;
  const generatedFile = new File(
    [new Uint8Array(finalImage)],
    `tra-creative-${item.index}.png`,
    { type: 'image/png' }
  );
  await options.assertCurrentWork?.();
  const image = await storage.saveImage(generatedFile);
  const uploadedReferenceImageId =
    item.strategy.referenceSelection?.layoutSource ?? undefined;
  const attachedSource: CreativeGenerationProvenance['attachedSource'] =
    itemImageSource
      ? {
          type: 'TRA_REFERENCE_IMAGE',
          mediaId: itemImageSource.media.id,
          sha256: sha256(itemImageSource.stored.buffer),
        }
      : providerFrames
        ? {
            type: 'TRA_VIDEO_FRAMES',
            mediaId: providerFrames[0].sourceVideoMediaId,
            sourceSha256: providerFrames[0].sourceVideoContentHash,
            selectionMode: human || request.videoFrameSelection
              ? 'USER_SELECTED'
              : 'AUTOMATIC',
            frames: providerFrames.map((frame) => ({
              timestampMs: frame.timestampMs,
              approvedPngSha256: frame.frameSha256,
            })),
          }
        : null;
  const generationProvenance: CreativeGenerationProvenance = {
    version: 1,
    imageGeneration: {
      prompt: imageResult.prompt,
      model: imageResult.model,
      routing: imageResult.routing,
    },
    requestedSources: itemRequestedSources,
    attachedSource,
    analysisSources,
    ...(logoOverlaySource ? { logoOverlaySource } : {}),
  };

  const creative: GeneratedCreative = {
    id: creativeId,
    index: item.index,
    category: item.strategy.category,
    format: item.format,
    placement: request.placement,
    image,
    copy,
    ...(copyMode.kind === 'E2' ? { adCopy: copyMode.adCopy, imageCopy: copyMode.imageCopy } : {}),
    generationProvenance,
    ...(proofProvenance ? { proofProvenance } : {}),
    identity,
    planning: {
      strategy: item.strategy,
      ...(logoAnchor ? { logoAnchor } : {}),
      selectionReason: item.selectionReason,
      model: batchPlan.plannerModel,
      reasoningEffort: batchPlan.reasoningEffort,
      ...(batchPlan.portfolioAudit ? { portfolioAudit: batchPlan.portfolioAudit } : {}),
      referenceCatalog: referenceCatalog.filter(reference =>
        [item.strategy.referenceSelection?.angleSource, item.strategy.referenceSelection?.layoutSource].includes(reference.referenceId)),
    },
    ...(itemFrameSelection
      ? { videoFrameSelection: itemFrameSelection }
      : {}),
    ...(selectedReference
      ? {
          referenceImageId: selectedReference.item.id,
          referenceImageUrl: selectedReference.item.url,
          referenceCategory: selectedReference.item.angle,
          referenceSelectionReason: selectedReference.selectionReason,
        }
      : uploadedReferenceImageId
        ? { referenceImageId: uploadedReferenceImageId }
        : {}),
  };
  await options.assertCurrentWork?.();
  const [saved] = await saveCreativeBatch([{ ...creative, createdAt: new Date().toISOString() }]);
  return { ...creative, finalization: { status: 'SAVED', createdAt: saved.createdAt } };
}
