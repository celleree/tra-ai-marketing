import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { getJpegDimensions } from '@/lib/video/candidate-file-integrity';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { videoCandidateFrameId, type VideoCandidateFrameBinding } from '@/lib/video/generation-selection-contract';
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
  preparationSha256?: string;
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
    return { library, manifest: loaded.manifest, representativeImages: bindRepresentativeImages(library, loaded.representatives),
      librarySha256: stored.job.result!.sha256, preparationSha256: preparation.manifestSha256 };
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
  return { library, manifest: loaded.manifest, representativeImages: bindRepresentativeImages(library, loaded.representatives),
    librarySha256: artifact.sha256, preparationSha256: preparation.manifestSha256 };
};

export const extractVideoSelectionFrames = async (source: HydratedTraVideoSource, context: VideoSelectionContext,
  frameIds: readonly string[] | readonly VideoCandidateFrameBinding[]) => {
  return context.manifest
    ? getApprovedPreparedSelectedTraVideoFrames(source, context.library, frameIds, context.manifest)
    : getApprovedSelectedTraVideoFrames(source, context.library, frameIds);
};

/** Bounded candidate JPEGs are regenerated and verified from the hydrated original, never sent to image generation. */
export const loadVideoCandidateAnalysisImage = async (source: HydratedTraVideoSource,
  context: VideoSelectionContext, candidateIndex: number) => {
  const { library, manifest } = context;
  const candidate = library.candidates.find((entry) => entry.candidateIndex === candidateIndex);
  const representative = library.representativeFrames.find((frame) => frame.candidateIndexes.includes(candidateIndex));
  const prepared = manifest?.candidates[candidateIndex];
  if (!manifest || !candidate || !representative || !prepared
    || library.sourceVideoMediaId !== source.media.id || library.sourceVideoContentHash !== videoSourceHash(source)
    || manifest.sourceVideoMediaId !== source.media.id || manifest.sourceVideoContentHash !== library.sourceVideoContentHash
    || !manifest.groups.some((group) => group.representativeIndex === representative.candidateIndex
      && group.candidateIndexes.includes(candidateIndex))
    || candidate.timestampMs !== prepared.timestampMs || candidate.frameSha256 !== prepared.frameSha256) {
    throw new Error('Candidate analysis does not match its frozen TRA video preparation.');
  }
  return withTemporaryTraVideoFrameCandidates(source, async (set) => {
    const regenerated = set.candidates[candidateIndex];
    if (set.sourceVideoContentHash !== library.sourceVideoContentHash || set.durationMs !== manifest.durationMs
      || !regenerated || regenerated.timestampMs !== candidate.timestampMs
      || regenerated.frameSha256 !== candidate.frameSha256) throw new Error('Candidate analysis frame has drifted.');
    const bytes = await readFile(regenerated.temporaryPath);
    const dimensions = getJpegDimensions(bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== candidate.frameSha256
      || dimensions?.width !== candidate.width || dimensions?.height !== candidate.height) {
      throw new Error('Candidate analysis JPEG failed source integrity validation.');
    }
    return { frameId: videoCandidateFrameId(library.sourceVideoContentHash, candidate.timestampMs, candidate.frameSha256),
      representativeFrameId: representative.id, candidateIndex, timestampMs: candidate.timestampMs,
      frameSha256: candidate.frameSha256, width: candidate.width, height: candidate.height, bytes };
  }, {}, manifest.analyzerFingerprint.candidatePolicy);
};
