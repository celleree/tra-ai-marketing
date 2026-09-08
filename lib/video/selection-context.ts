import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { readVideoIntelligenceJob } from '@/lib/video/intelligence-job-store';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import type { VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import { createCurrentVideoIntelligenceIdentity } from '@/lib/video/intelligence-service';
import { loadVideoFrameLibrary, videoSourceHash } from '@/lib/video/library-service';
import { getApprovedPreparedSelectedTraVideoFrames } from '@/lib/video/prepared-selected-frames';
import { getApprovedSelectedTraVideoFrames } from '@/lib/video/selected-frames';

export interface VideoSelectionContext {
  library: VideoFrameLibrary;
  manifest: VideoIntelligencePreparationManifest | null;
}

export const loadVideoSelectionContext = async (source: HydratedTraVideoSource): Promise<VideoSelectionContext | null> => {
  const identity = createCurrentVideoIntelligenceIdentity(source.media.id, videoSourceHash(source));
  const stored = await readVideoIntelligenceJob(identity);
  if (stored?.job.phase === 'COMPLETE') {
    const preparation = stored.job.preparation!;
    const [library, loaded] = await Promise.all([
      loadVideoIntelligenceLibrary(identity, stored.job.result!),
      loadVideoIntelligencePreparation({ manifestKey: preparation.manifestKey, manifestSha256: preparation.manifestSha256,
        expectedSourceVideoMediaId: identity.sourceVideoMediaId, expectedSourceVideoContentHash: identity.sourceVideoContentHash,
        expectedAnalyzerFingerprintSha256: identity.analyzerFingerprint.sha256 }),
    ]);
    return { library, manifest: loaded.manifest };
  }
  if (process.env.NODE_ENV === 'production') return null;
  const library = await loadVideoFrameLibrary(identity.sourceVideoMediaId, identity.sourceVideoContentHash);
  return library ? { library, manifest: null } : null;
};

export const extractVideoSelectionFrames = (source: HydratedTraVideoSource, context: VideoSelectionContext, frameIds: readonly string[]) =>
  context.manifest
    ? getApprovedPreparedSelectedTraVideoFrames(source, context.library, frameIds, context.manifest)
    : getApprovedSelectedTraVideoFrames(source, context.library, frameIds);
