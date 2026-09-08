import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assembleVideoFrameLibrary, type VideoFrameLibrary } from '@/lib/video/frame-library';
import type { VideoFrameThumbnail } from '@/lib/video/frame-thumbnail';
import {
  videoIntelligenceJobKey,
  type VideoIntelligenceArtifactReference,
  type VideoIntelligenceFrameObservation,
  type VideoIntelligenceJobIdentity,
} from '@/lib/video/intelligence-job';
import {
  checkpointVideoIntelligenceJob,
  readVideoIntelligenceJob,
  VideoIntelligenceJobLeaseLostError,
} from '@/lib/video/intelligence-job-store';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { normalizePersistedVideoFrameLibrary } from '@/lib/video/library-service';

export const MAX_VIDEO_INTELLIGENCE_LIBRARY_BYTES = 32 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const libraryKey = (sha256: string) => `libraries/sha256/${sha256}.json`;

const validatedLibrary = (value: unknown, identity: VideoIntelligenceJobIdentity): VideoFrameLibrary => {
  const library = normalizePersistedVideoFrameLibrary(value, identity.sourceVideoMediaId, identity.sourceVideoContentHash);
  if (!library || library.analysisModels.vision.length !== 1
    || library.analysisModels.vision[0] !== identity.analyzerFingerprint.visionModel) {
    throw new Error('Finalized video library does not match the source and analyzer.');
  }
  return library;
};

export const loadVideoIntelligenceLibrary = async (
  identity: VideoIntelligenceJobIdentity,
  reference: VideoIntelligenceArtifactReference,
  dependencies: { storage?: VideoIntelligenceStorage } = {}
): Promise<VideoFrameLibrary> => {
  videoIntelligenceJobKey(identity);
  if (!/^[a-f0-9]{64}$/.test(reference.sha256) || reference.key !== libraryKey(reference.sha256)
    || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 1
    || reference.byteLength > MAX_VIDEO_INTELLIGENCE_LIBRARY_BYTES) {
    throw new Error('Finalized video library reference is invalid.');
  }
  const stored = await (dependencies.storage ?? getVideoIntelligenceStorage()).read(reference.key);
  if (!stored || stored.bytes.length > MAX_VIDEO_INTELLIGENCE_LIBRARY_BYTES
    || stored.bytes.length !== reference.byteLength || digest(stored.bytes) !== reference.sha256) {
    throw new Error('Finalized video library artifact is missing or corrupt.');
  }
  return validatedLibrary(JSON.parse(stored.bytes.toString('utf8')), identity);
};

export const runVideoIntelligenceFinalizationJob = async (
  identity: VideoIntelligenceJobIdentity,
  leaseId: string,
  dependencies: {
    storage?: VideoIntelligenceStorage;
    now?: () => number;
    loadPreparation?: typeof loadVideoIntelligencePreparation;
  } = {}
) => {
  const storage = dependencies.storage ?? getVideoIntelligenceStorage();
  const storeDependencies = { storage, now: dependencies.now };
  const current = await readVideoIntelligenceJob(identity, storeDependencies);
  if (!current || current.job.phase !== 'FINALIZING' || current.job.lease?.id !== leaseId) {
    throw new VideoIntelligenceJobLeaseLostError();
  }
  const job = current.job;
  const preparation = job.preparation!;
  const { manifest } = await (dependencies.loadPreparation ?? loadVideoIntelligencePreparation)({
    manifestKey: preparation.manifestKey,
    manifestSha256: preparation.manifestSha256,
    expectedSourceVideoMediaId: identity.sourceVideoMediaId,
    expectedSourceVideoContentHash: identity.sourceVideoContentHash,
    expectedAnalyzerFingerprintSha256: identity.analyzerFingerprint.sha256,
  }, { storage });
  if (manifest.durationMs !== preparation.durationMs
    || !isDeepStrictEqual(manifest.analyzerFingerprint, job.analyzerFingerprint)
    || !isDeepStrictEqual(manifest.representativeBundle.entries.map((entry) => entry.candidateIndex), preparation.representativeCandidateIndexes)) {
    throw new Error('Video finalization preparation does not match the job.');
  }
  const technical = {
    version: 1 as const, providerEligible: false as const,
    sourceVideoMediaId: manifest.sourceVideoMediaId, sourceVideoContentHash: manifest.sourceVideoContentHash,
    candidates: manifest.candidates.map(({ candidateIndex, frameSha256, technical }) => ({ candidateIndex, frameSha256, technical })),
    groups: manifest.groups,
  };
  const thumbnails = new Map<number, VideoFrameThumbnail>();
  const observations: VideoIntelligenceFrameObservation[] = [];
  for (const entry of job.representatives) {
    thumbnails.set(entry.candidateIndex, entry.thumbnail!);
    observations.push(entry.observation!);
  }
  const library = validatedLibrary(assembleVideoFrameLibrary(manifest, technical, job.transcript!, observations, thumbnails), identity);
  const bytes = Buffer.from(JSON.stringify(library));
  if (bytes.length > MAX_VIDEO_INTELLIGENCE_LIBRARY_BYTES) {
    throw new Error('Finalized video library exceeds the 32 MiB storage limit.');
  }
  const sha256 = digest(bytes);
  const reference = { key: libraryKey(sha256), sha256, byteLength: bytes.length };
  // A retry may find its immutable artifact after an earlier checkpoint failed.
  if (!await storage.write(reference.key, bytes, null)) {
    const existing = await storage.read(reference.key);
    if (!existing || !existing.bytes.equals(bytes)) throw new Error('Finalized video library artifact collision.');
  }
  return checkpointVideoIntelligenceJob(identity, leaseId,
    (currentJob) => ({ ...currentJob, phase: 'COMPLETE', lease: null, result: reference }), storeDependencies);
};
