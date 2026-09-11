import { isDeepStrictEqual } from 'node:util';
import type { PreparedCreativeGeneration } from '@/lib/creatives/prepare-generation';
import { hydrateGenerationSources, CreativeGenerationPreparationError } from '@/lib/creatives/generation-sources';

export type CreativePortfolioSnapshot = Pick<PreparedCreativeGeneration,
  'request' | 'batchPlan' | 'referenceCatalog' | 'selectedReferences' | 'requestedSources' | 'analysisSources'
  | 'logoOverlaySource' | 'generatedVideoFrameSelection'> & {
  version: 1;
  videoFrames: Array<{ timestampMs: number; sha256: string }>;
};
const frameIdentities = (prepared: Pick<PreparedCreativeGeneration, 'videoFrameSet'>) =>
  prepared.videoFrameSet?.frames.map(frame => ({ timestampMs: frame.timestampMs, sha256: frame.frameSha256 })) ?? [];

/** Only serializable plan/provenance fields; never persist buffers or source eligibility objects. */
export function snapshotCreativePortfolio(prepared: PreparedCreativeGeneration): CreativePortfolioSnapshot {
  const { request, batchPlan, referenceCatalog, selectedReferences, requestedSources, analysisSources,
    logoOverlaySource, generatedVideoFrameSelection } = prepared;
  return structuredClone({
    version: 1, request, batchPlan, referenceCatalog, selectedReferences, requestedSources, analysisSources,
    ...(logoOverlaySource ? { logoOverlaySource } : {}),
    ...(generatedVideoFrameSelection ? { generatedVideoFrameSelection } : {}),
    videoFrames: frameIdentities(prepared),
  });
}

/** Restore original source pixels through the existing validators without replanning the saved portfolio. */
export async function restoreCreativePortfolio(snapshot: CreativePortfolioSnapshot): Promise<PreparedCreativeGeneration> {
  if (snapshot.version !== 1) throw new CreativeGenerationPreparationError('Unsupported creative portfolio snapshot.', 409);
  const saved = structuredClone(snapshot);
  const sources = await hydrateGenerationSources(saved.request);
  if (!isDeepStrictEqual(sources.requestedSources, saved.requestedSources)
    || !isDeepStrictEqual(sources.logoOverlaySource, saved.logoOverlaySource)
    || !isDeepStrictEqual(sources.generatedVideoFrameSelection, saved.generatedVideoFrameSelection)
    || !isDeepStrictEqual(frameIdentities(sources), saved.videoFrames)) {
    throw new CreativeGenerationPreparationError('Portfolio source media changed after planning. Start a new portfolio with the current sources.', 409);
  }
  return { request: saved.request, batchPlan: saved.batchPlan, referenceCatalog: saved.referenceCatalog,
    selectedReferences: saved.selectedReferences, requestedSources: saved.requestedSources, analysisSources: saved.analysisSources,
    logoOverlaySource: saved.logoOverlaySource, generatedVideoFrameSelection: saved.generatedVideoFrameSelection,
    storage: sources.storage, brandLogo: sources.brandLogo, reserveLogoArea: sources.reserveLogoArea,
    providerImageSource: sources.providerImageSource, videoFrameSet: sources.videoFrameSet };
}
