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
import { MAX_REVIEW_PREVIEW_BATCH } from '@/lib/video/review-preview-policy';
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

/** Read one verified JPEG at a time from one bounded preprocessing pass, then release its temporary files. */
export const withVideoCandidateAnalysisImages = async <T>(source: HydratedTraVideoSource,
  context: VideoSelectionContext, candidateIndexes: readonly number[],
  consume: (image: VideoSelectionRepresentativeImage & { representativeFrameId: string }) => Promise<T>) => {
  const { library, manifest } = context;
  if (!candidateIndexes.length || candidateIndexes.length > MAX_REVIEW_PREVIEW_BATCH
    || new Set(candidateIndexes).size !== candidateIndexes.length) throw new Error('Candidate analysis batch is invalid.');
  const sourceHash = videoSourceHash(source);
  const candidates = candidateIndexes.map(candidateIndex => {
    const candidate = library.candidates.find((entry) => entry.candidateIndex === candidateIndex);
    const representative = library.representativeFrames.find((frame) => frame.candidateIndexes.includes(candidateIndex));
    const prepared = manifest?.candidates[candidateIndex];
    if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0 || !manifest || !candidate || !representative || !prepared
      || library.sourceVideoMediaId !== source.media.id || library.sourceVideoContentHash !== sourceHash
      || manifest.sourceVideoMediaId !== source.media.id || manifest.sourceVideoContentHash !== library.sourceVideoContentHash
      || !manifest.groups.some((group) => group.representativeIndex === representative.candidateIndex
        && group.candidateIndexes.includes(candidateIndex))
      || candidate.timestampMs !== prepared.timestampMs || candidate.frameSha256 !== prepared.frameSha256) {
      throw new Error('Candidate analysis does not match its frozen TRA video preparation.');
    }
    return { candidate, representative };
  });
  return withTemporaryTraVideoFrameCandidates(source, async (set) => {
    const results: T[] = [];
    for (const { candidate, representative } of candidates) {
      const regenerated = set.candidates[candidate.candidateIndex];
      if (set.sourceVideoContentHash !== library.sourceVideoContentHash || set.durationMs !== manifest!.durationMs
        || !regenerated || regenerated.timestampMs !== candidate.timestampMs
        || regenerated.frameSha256 !== candidate.frameSha256) throw new Error('Candidate analysis frame has drifted.');
      const bytes = await readFile(regenerated.temporaryPath);
      const dimensions = getJpegDimensions(bytes);
      if (createHash('sha256').update(bytes).digest('hex') !== candidate.frameSha256
        || dimensions?.width !== candidate.width || dimensions?.height !== candidate.height) {
        throw new Error('Candidate analysis JPEG failed source integrity validation.');
      }
      results.push(await consume({ frameId: videoCandidateFrameId(library.sourceVideoContentHash, candidate.timestampMs, candidate.frameSha256),
        representativeFrameId: representative.id, candidateIndex: candidate.candidateIndex, timestampMs: candidate.timestampMs,
        frameSha256: candidate.frameSha256, width: candidate.width, height: candidate.height, bytes }));
    }
    return results;
  }, {}, manifest!.analyzerFingerprint.candidatePolicy);
};

/** Single-candidate callers retain the same validated analysis-only boundary. */
export const loadVideoCandidateAnalysisImage = async (source: HydratedTraVideoSource,
  context: VideoSelectionContext, candidateIndex: number) =>
  (await withVideoCandidateAnalysisImages(source, context, [candidateIndex], async image => image))[0];
