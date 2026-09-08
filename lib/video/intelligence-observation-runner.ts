import { isDeepStrictEqual } from 'node:util';
import { createVideoFrameThumbnailFromBytes } from '@/lib/video/frame-thumbnail';
import type {
  VideoIntelligenceFrameObservation,
  VideoIntelligenceJob,
  VideoIntelligenceJobIdentity,
  VideoIntelligenceRepresentativeProgress,
} from '@/lib/video/intelligence-job';
import {
  checkpointVideoIntelligenceJob,
  readVideoIntelligenceJob,
  VideoIntelligenceJobLeaseLostError,
} from '@/lib/video/intelligence-job-store';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { observeVideoFrameBytes, VIDEO_VISION_TIMEOUT_MS } from '@/lib/video/visual-observation';

const CHECKPOINT_RESERVE_MS = 65_000;
const RETRY_MESSAGE_MAX_LENGTH = 2_000;

export interface VideoIntelligenceObservationRunnerDependencies {
  deadlineAtMs: number;
  storage?: VideoIntelligenceStorage;
  now?: () => number;
  request?: typeof fetch;
}

const messageFor = (error: unknown) =>
  (error instanceof Error ? error.message : 'Video observation failed.').slice(0, RETRY_MESSAGE_MAX_LENGTH);

const mergeProgress = (
  job: VideoIntelligenceJob,
  completed: Array<VideoIntelligenceRepresentativeProgress>
) => {
  const byIndex = new Map(job.representatives.map((entry) => [entry.candidateIndex, entry]));
  for (const entry of completed) byIndex.set(entry.candidateIndex, { ...byIndex.get(entry.candidateIndex), ...entry });
  return [...byIndex.values()].sort((left, right) => left.candidateIndex - right.candidateIndex);
};

export const runVideoIntelligenceObservationJob = async (
  identity: VideoIntelligenceJobIdentity,
  leaseId: string,
  dependencies: VideoIntelligenceObservationRunnerDependencies
): Promise<VideoIntelligenceJob> => {
  if (!Number.isSafeInteger(dependencies.deadlineAtMs)) {
    throw new Error('Video intelligence observation requires a safe server deadline timestamp.');
  }
  const storeDependencies = { storage: dependencies.storage, now: dependencies.now };
  const current = await readVideoIntelligenceJob(identity, storeDependencies);
  const activeLease = current?.job.lease;
  if (!current || current.job.phase !== 'OBSERVING' || activeLease?.id !== leaseId || activeLease.phase !== 'OBSERVING') {
    throw new VideoIntelligenceJobLeaseLostError();
  }

  const preparation = current.job.preparation!;
  const loaded = await loadVideoIntelligencePreparation({
    manifestKey: preparation.manifestKey,
    manifestSha256: preparation.manifestSha256,
    expectedSourceVideoMediaId: identity.sourceVideoMediaId,
    expectedSourceVideoContentHash: identity.sourceVideoContentHash,
    expectedAnalyzerFingerprintSha256: identity.analyzerFingerprint.sha256,
  }, { storage: dependencies.storage });
  const canonicalIndexes = loaded.manifest.representativeBundle.entries.map(({ candidateIndex }) => candidateIndex);
  if (loaded.manifest.durationMs !== preparation.durationMs
    || !isDeepStrictEqual(canonicalIndexes, preparation.representativeCandidateIndexes)) {
    throw new Error('Video intelligence observation preparation does not match the current job.');
  }

  const loadedByIndex = new Map(loaded.representatives.map((entry) => [entry.candidate.candidateIndex, entry]));
  const work = activeLease.candidateIndexes!.map((candidateIndex) => {
    const representative = loadedByIndex.get(candidateIndex);
    if (!representative) throw new Error(`Video intelligence observation candidate ${candidateIndex} is missing.`);
    const saved = current.job.representatives.find((entry) => entry.candidateIndex === candidateIndex);
    if (saved && (saved.frameSha256 !== representative.candidate.frameSha256
      || (saved.thumbnail && saved.thumbnail.timestampMs !== representative.candidate.timestampMs)
      || (saved.observation && saved.observation.timestampMs !== representative.candidate.timestampMs))) {
      throw new Error(`Video intelligence observation candidate ${candidateIndex} does not match saved progress.`);
    }
    return { ...representative, saved };
  });
  const thumbnails = await Promise.all(work.map(async ({ candidate, bytes, saved }) =>
    saved?.thumbnail ?? createVideoFrameThumbnailFromBytes(candidate, bytes)));
  const prepared = work.map(({ candidate, saved }, index) => ({
    candidateIndex: candidate.candidateIndex,
    frameSha256: candidate.frameSha256,
    thumbnail: thumbnails[index],
    ...(saved?.observation ? { observation: saved.observation } : {}),
  }));
  const missing = work.filter(({ saved }) => !saved?.observation);
  const checkpoint = (
    progress: Array<VideoIntelligenceRepresentativeProgress>,
    failed?: Array<{ candidateIndex: number; reason: unknown }>
  ) => checkpointVideoIntelligenceJob(identity, leaseId, (job) => ({
    ...job,
    representatives: mergeProgress(job, progress),
    phase: failed?.length ? 'RETRY_REQUIRED' : 'OBSERVING',
    lease: null,
    ...(failed?.length ? { retry: {
      phase: 'OBSERVING' as const,
      candidateIndexes: failed.map(({ candidateIndex }) => candidateIndex) as [number] | [number, number],
      reason: 'PAID_WORK_FAILED' as const,
      message: failed.map(({ candidateIndex, reason }) => `Candidate ${candidateIndex}: ${messageFor(reason)}`)
        .join('; ').slice(0, RETRY_MESSAGE_MAX_LENGTH),
    } } : {}),
  }), storeDependencies);

  if (!missing.length) return checkpoint(prepared);
  const effectiveDeadlineAtMs = Math.min(dependencies.deadlineAtMs, activeLease.expiresAtMs);
  if (effectiveDeadlineAtMs - (dependencies.now ?? Date.now)() < VIDEO_VISION_TIMEOUT_MS + CHECKPOINT_RESERVE_MS) {
    return checkpoint(prepared, missing.map(({ candidate }) => ({ candidateIndex: candidate.candidateIndex,
      reason: new Error('Video observation requests not started: insufficient time remaining before the server or lease deadline.') })));
  }

  const results = await Promise.allSettled(missing.map(({ candidate, bytes }) => observeVideoFrameBytes(candidate, bytes, {
    model: current.job.analyzerFingerprint.visionModel,
    request: dependencies.request,
  })));
  const observations = new Map<number, VideoIntelligenceFrameObservation>();
  const failed: Array<{ candidateIndex: number; reason: unknown }> = [];
  results.forEach((result, index) => {
    const candidateIndex = missing[index].candidate.candidateIndex;
    if (result.status === 'fulfilled') observations.set(candidateIndex, result.value);
    else failed.push({ candidateIndex, reason: result.reason });
  });
  const progress = prepared.map((entry) => ({
    ...entry,
    ...(observations.has(entry.candidateIndex) ? { observation: observations.get(entry.candidateIndex)! } : {}),
  }));
  return checkpoint(progress, failed);
};
