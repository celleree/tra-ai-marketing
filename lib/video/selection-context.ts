import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import type { VideoIntelligenceArtifactReference, VideoIntelligenceJobIdentity } from '@/lib/video/intelligence-job';
import { readVideoIntelligenceJob } from '@/lib/video/intelligence-job-store';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import type { VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import { createCurrentVideoIntelligenceIdentity } from '@/lib/video/intelligence-service';
import { loadVideoFrameLibrary, videoSourceHash } from '@/lib/video/library-service';
import { getApprovedPreparedSelectedTraVideoFrames } from '@/lib/video/prepared-selected-frames';
import { getApprovedSelectedTraVideoFrames } from '@/lib/video/selected-frames';
import type { VideoSelectionRepresentativeImage } from '@/lib/video/human-frame-selection';

export interface VideoSelectionContext {
  library: VideoFrameLibrary;
  manifest: VideoIntelligencePreparationManifest | null;
  representativeImages: VideoSelectionRepresentativeImage[] | null;
  librarySha256?: string;
}

export interface SavedVideoSelectionDependency {
  identity: VideoIntelligenceJobIdentity;
  artifact: VideoIntelligenceArtifactReference;
}

const bindRepresentativeImages = (
  library: VideoFrameLibrary,
  representatives: Awaited<ReturnType<typeof loadVideoIntelligencePreparation>>['representatives'],
) => {
  const frames = new Map(library.representativeFrames.map((frame) => [frame.candidateIndex, frame]));
  if (representatives.length !== frames.size || representatives.some(({ candidate }) => !frames.has(candidate.candidateIndex))) {
    throw new Error('Saved video intelligence representative images do not match the frozen library.');
  }
  return representatives.map(({ candidate, bytes }) => ({
    frameId: frames.get(candidate.candidateIndex)!.id, candidateIndex: candidate.candidateIndex,
    timestampMs: candidate.timestampMs, frameSha256: candidate.frameSha256,
    width: candidate.width, height: candidate.height, bytes,
  }));
};

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
    return { library, manifest: loaded.manifest, representativeImages: bindRepresentativeImages(library, loaded.representatives), librarySha256: stored.job.result!.sha256 };
  }
  if (process.env.NODE_ENV === 'production') return null;
  const library = await loadVideoFrameLibrary(identity.sourceVideoMediaId, identity.sourceVideoContentHash);
  return library ? { library, manifest: null, representativeImages: null } : null;
};

/** Strictly restore selection context from the exact completed B1 dependency saved by a portfolio. */
export const loadSavedVideoSelectionContext = async (
  source: HydratedTraVideoSource,
  dependency: SavedVideoSelectionDependency,
): Promise<VideoSelectionContext> => {
  const { identity, artifact } = dependency;
  if (source.media.id !== identity.sourceVideoMediaId || videoSourceHash(source) !== identity.sourceVideoContentHash) {
    throw new Error('Saved video intelligence dependency does not match the TRA video source.');
  }
  const stored = await readVideoIntelligenceJob(identity);
  if (!stored || stored.job.phase !== 'COMPLETE' || !stored.job.preparation || !stored.job.result) {
    throw new Error('Saved video intelligence dependency is not a complete persisted job.');
  }
  const result = stored.job.result;
  if (result.key !== artifact.key || result.sha256 !== artifact.sha256 || result.byteLength !== artifact.byteLength) {
    throw new Error('Saved video intelligence result artifact does not match the frozen dependency.');
  }
  const preparation = stored.job.preparation;
  const [library, loaded] = await Promise.all([
    loadVideoIntelligenceLibrary(identity, artifact),
    loadVideoIntelligencePreparation({ manifestKey: preparation.manifestKey, manifestSha256: preparation.manifestSha256,
      expectedSourceVideoMediaId: identity.sourceVideoMediaId, expectedSourceVideoContentHash: identity.sourceVideoContentHash,
      expectedAnalyzerFingerprintSha256: identity.analyzerFingerprint.sha256 }),
  ]);
  return { library, manifest: loaded.manifest, representativeImages: bindRepresentativeImages(library, loaded.representatives), librarySha256: artifact.sha256 };
};

export const extractVideoSelectionFrames = async (source: HydratedTraVideoSource, context: VideoSelectionContext, frameIds: readonly string[]) => {
  return context.manifest
    ? getApprovedPreparedSelectedTraVideoFrames(source, context.library, frameIds, context.manifest)
    : getApprovedSelectedTraVideoFrames(source, context.library, frameIds);
};
