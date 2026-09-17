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
import { compositeCreativeBrandLogo } from '@/lib/creatives/brand-logo.server';
import { saveCreativeBatch } from '@/lib/creatives/storage';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { validateGeneratedCreativeImage } from '@/lib/creatives/generated-image-validation';
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

const copyMatchesAdCopy = (item: PlannedCreativeConcept) =>
  Boolean(item.adCopy)
  && item.copy.primaryText === item.adCopy!.primaryText
  && item.copy.headline === item.adCopy!.headline
  && item.copy.description === item.adCopy!.description;

type PlannedCopyMode =
  | { kind: 'LEGACY' }
  | { kind: 'E2'; adCopy: CreativeAdCopy; imageCopy: CreativeImageCopy };

const classifyPlannedCopy = (item: PlannedCreativeConcept): PlannedCopyMode => {
  const hasAdCopy = item.adCopy !== undefined;
  const hasImageCopy = item.imageCopy !== undefined;
  if (!hasAdCopy && !hasImageCopy) return { kind: 'LEGACY' };
  if (!hasAdCopy || !hasImageCopy || !copyMatchesAdCopy(item)) {
    throw new Error('Creative plan has an invalid separated ad/image copy contract and cannot be rendered.');
  }
  return { kind: 'E2', adCopy: item.adCopy!, imageCopy: item.imageCopy! };
};

/** The shared one-ad provider, validation, branding and persistence path. */
export async function renderPlannedCreative(item: PlannedCreativeConcept, {
  request, batchPlan, referenceCatalog, selectedReferences, requestedSources, analysisSources, logoOverlaySource,
  reserveLogoArea, brandLogo, providerImageSource, videoFrameSet, generatedVideoFrameSelection, storage,
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
  const itemContext = formatCreativeRenderBrief(buildCreativeRenderBrief({
    concept: item, companyProfile: request.companyProfile,
    brandColors: request.brandColors, brandFontNames: request.brandFontNames,
    referenceCatalog,
  }));
  let imageResult: ImageGenerationResult;
  let providerFrames: ApprovedTraVideoFrame[] | undefined;

  await options.assertCurrentWork?.();

  if (itemImageSource) {
    imageResult = copyMode.kind === 'LEGACY'
      ? await generateLegacyApprovedTraReferenceCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          source: itemImageSource.stored,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy,
          reserveLogoArea,
        })
      : await generateApprovedTraReferenceCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          source: itemImageSource.stored,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy: copyMode.imageCopy,
          reserveLogoArea,
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
          reserveLogoArea,
        })
      : await generateApprovedTraVideoFrameCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          frames: itemVideoFrames.frames,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy: copyMode.imageCopy,
          reserveLogoArea,
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
          reserveLogoArea,
          operationType: item.strategy.referenceSelection?.layoutSource ? 'LAYOUT_REFERENCE_GENERATION' : 'PROMPT_GENERATION',
        })
      : await generatePromptOnlyCreativeImage({
          taxDocumentReference: item.strategy.execution.taxDocumentReference,
          primaryFormat: item.format,
          placement: request.placement,
          context: itemContext,
          copy: copyMode.imageCopy,
          reserveLogoArea,
          operationType: item.strategy.referenceSelection?.layoutSource ? 'LAYOUT_REFERENCE_GENERATION' : 'PROMPT_GENERATION',
        });
  }

  await validateGeneratedCreativeImage(imageResult.buffer, request.placement);
  const finalImage = brandLogo
    ? await compositeCreativeBrandLogo(imageResult.buffer, brandLogo.buffer, request.placement)
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
    identity,
    planning: {
      strategy: item.strategy,
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
