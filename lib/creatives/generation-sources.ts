import { createHash } from 'crypto';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { getMediaStorage } from '@/lib/media/local-storage';
import type { MediaStorage } from '@/lib/media/storage';
import { findEligibleProviderImageSource, hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { isDurableVideoIntelligenceAvailable } from '@/lib/video/preview-availability';
import { videoSourceHash } from '@/lib/video/library-service';
import { extractVideoSelectionFrames, loadVideoSelectionContext } from '@/lib/video/selection-context';
import { getApprovedTraVideoFrames } from '@/lib/video/tra-video-frames';
import type { ApprovedTraVideoFrameSet } from '@/lib/video/types';

type SourceRequest = Pick<ValidGenerateCreativeRequest, 'sourceAssets' | 'videoFrameSelection' | 'brandLogoMediaId'>;
export class CreativeGenerationPreparationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function assertGenerationAvailable(request: Pick<SourceRequest, 'videoFrameSelection'>) {
  if (request.videoFrameSelection && !isDurableVideoIntelligenceAvailable()) {
    throw new CreativeGenerationPreparationError('Selected TRA video frame generation is available in local development or protected Vercel Preview only.', 404);
  }
  if (!process.env.OPENAI_API_KEY) throw new CreativeGenerationPreparationError('OpenAI generation is not configured yet.', 503);
}
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/** Planning-only inventory. Does not choose render attachments or extract/approve human frames. */
export async function hydratePlanningSourceInventory(sourceAssets: SourceRequest['sourceAssets'], storage: MediaStorage = getMediaStorage()) {
  if (new Set(sourceAssets.map(source => source.mediaId)).size !== sourceAssets.length) {
    throw new CreativeGenerationPreparationError('Planning sources contain duplicate media IDs.', 400);
  }
  return (await hydrateCreativeSourceSelections(storage, sourceAssets)).map(source => ({
    source, identity: { role: source.role, mediaId: source.media.id, sha256: sha256(source.stored.buffer) },
  }));
}

/** Reuse canonical source hydration and existing video extraction for planning or rendering. */
export async function hydrateGenerationSources(request: SourceRequest) {
  assertGenerationAvailable(request);
  const storage = getMediaStorage();
  const sourceAssets = await hydrateCreativeSourceSelections(storage, request.sourceAssets);
  const generationSourceAsset = sourceAssets.find(source => source.role === 'LAYOUT_REFERENCE' && source.media.mediaType === 'IMAGE')
    || sourceAssets.find(source => source.media.mediaType === 'IMAGE');
  const requestedSources: CreativeGenerationProvenance['requestedSources'] = sourceAssets.map(asset => ({
    role: asset.role, mediaId: asset.media.id, sha256: sha256(asset.stored.buffer),
  }));
  const source = generationSourceAsset?.stored.mediaType === 'IMAGE' ? generationSourceAsset.stored : null;
  const providerImageSource = findEligibleProviderImageSource(sourceAssets);
  const traVideoSource = sourceAssets.find(asset => asset.role === 'TRA_VIDEO') as HydratedTraVideoSource | undefined;
  let videoFrameSet: ApprovedTraVideoFrameSet | null = null;
  let generatedVideoFrameSelection: GeneratedVideoFrameSelection | undefined;
  if (request.videoFrameSelection && traVideoSource) {
    const selection = request.videoFrameSelection;
    if (selection.version !== 2 || !selection.sourceOverlays || selection.sourceOverlays.length !== selection.frameIds.length) {
      throw new CreativeGenerationPreparationError('Selected TRA video frames are unassessed. Reassess the exact frames before generation.', 409);
    }
    if (videoSourceHash(traVideoSource) !== selection.sourceVideoContentHash) {
      throw new CreativeGenerationPreparationError('The selected TRA video frames are stale. Reanalyze the video and select frames again.', 409);
    }
    const context = await loadVideoSelectionContext(traVideoSource);
    if (!context?.library) throw new CreativeGenerationPreparationError('The selected TRA video frame library is missing or invalid. Reanalyze the video and select frames again.', 409);
    if (context.library.id !== selection.libraryId) throw new CreativeGenerationPreparationError('The selected TRA video frame library does not match this request. Select frames again.', 409);
    try {
      const selected = await extractVideoSelectionFrames(traVideoSource, context, selection.frameIds);
      if (selected.frames.length !== selection.frameIds.length || selected.selectionProvenance.length !== selection.frameIds.length
        || selected.selectionProvenance.some((frame, index) => frame.libraryFrameId !== selection.frameIds[index]
          || frame.frameIndex !== selected.frames[index].frameIndex || frame.timestampMs !== selected.frames[index].timestampMs
          || frame.approvedPngSha256 !== selected.frames[index].frameSha256)) {
        throw new Error('Selected TRA frame order or provenance changed. Reassess the exact frames.');
      }
      videoFrameSet = { ...selected, frames: selected.frames.map((frame, index) => ({ ...frame, sourceOverlay: selection.sourceOverlays![index] })) };
      generatedVideoFrameSelection = { libraryId: context.library.id, sourceVideoMediaId: traVideoSource.media.id,
        sourceVideoContentHash: selected.sourceVideoContentHash, frames: selected.selectionProvenance };
    } catch (error) {
      throw new CreativeGenerationPreparationError(error instanceof Error ? error.message : 'The selected TRA video frames could not be verified. Select frames again.', 409);
    }
  } else if (traVideoSource && !providerImageSource) {
    videoFrameSet = await getApprovedTraVideoFrames(traVideoSource);
  }
  const brandLogo = request.brandLogoMediaId ? await storage.readImageById(request.brandLogoMediaId) : null;
  if (request.brandLogoMediaId && !brandLogo) {
    throw new CreativeGenerationPreparationError('The saved TRA logo could not be found. Re-upload the logo in Company > Brand Guidelines and try again.', 404);
  }
  const reserveLogoArea = Boolean(brandLogo);
  const logoOverlaySource = brandLogo && request.brandLogoMediaId ? { mediaId: request.brandLogoMediaId, sha256: sha256(brandLogo.buffer) } : undefined;
  return { storage, generationSourceAsset, requestedSources, source, providerImageSource, videoFrameSet,
    generatedVideoFrameSelection, brandLogo, reserveLogoArea, logoOverlaySource };
}
