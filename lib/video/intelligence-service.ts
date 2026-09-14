import { createHash } from 'node:crypto';
import { getMediaStorage } from '@/lib/media/local-storage';
import { hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import type { CreativeSourceVideoAsset } from '@/lib/media/types';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { runVideoIntelligenceFinalizationJob } from '@/lib/video/intelligence-finalization-runner';
import type { VideoIntelligenceJob, VideoIntelligenceJobIdentity } from '@/lib/video/intelligence-job';
import { claimVideoIntelligenceJob, readVideoIntelligenceJob, retryVideoIntelligenceJob, startVideoIntelligenceJob } from '@/lib/video/intelligence-job-store';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import { runVideoIntelligencePreparationJob } from '@/lib/video/intelligence-preparation-runner';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { runVideoIntelligenceObservationJob } from '@/lib/video/intelligence-observation-runner';
import { runVideoIntelligenceTranscriptionJob } from '@/lib/video/intelligence-transcription-runner';
import { MAX_TRANSCRIPTION_UPLOAD_BYTES } from '@/lib/video/transcript';

const MEDIA_ID = /^media_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const isMediaId = (value: unknown): value is string => typeof value === 'string' && MEDIA_ID.test(value);

export interface VideoIntelligenceJobLocator {
  version: 1;
  sourceVideoMediaId: string;
  sourceVideoContentHash: string;
  analyzerFingerprintSha256: string;
}

export interface CompactVideoIntelligenceJobStatus {
  locator: VideoIntelligenceJobLocator;
  jobId: string;
  phase: VideoIntelligenceJob['phase'];
  busy: boolean;
  completedRepresentatives: number;
  totalRepresentatives: number | null;
  updatedAtMs: number;
  retry?: VideoIntelligenceJob['retry'];
  failure?: VideoIntelligenceJob['failure'];
}

export class VideoIntelligenceServiceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'VideoIntelligenceServiceError';
  }
}

type Runners = {
  preparation?: typeof runVideoIntelligencePreparationJob;
  transcription?: typeof runVideoIntelligenceTranscriptionJob;
  observation?: typeof runVideoIntelligenceObservationJob;
  finalization?: typeof runVideoIntelligenceFinalizationJob;
};

export interface VideoIntelligenceServiceDependencies extends Runners {
  deadlineAtMs: number;
  expectedRetryEtag?: string;
  storage?: VideoIntelligenceStorage;
  now?: () => number;
  hydrateSource?: (mediaId: string) => Promise<HydratedTraVideoSource>;
  request?: typeof fetch;
}

export type ExecuteVideoIntelligenceStepInput =
  | { action: 'START'; mediaId: string }
  | { action: 'STATUS' | 'ADVANCE' | 'RETRY'; locator: VideoIntelligenceJobLocator };

const currentIdentity = (mediaId: string, contentHash: string): VideoIntelligenceJobIdentity => ({
  sourceVideoMediaId: mediaId,
  sourceVideoContentHash: contentHash,
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(
    DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
    process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra'
  ),
});

export { currentIdentity as createCurrentVideoIntelligenceIdentity };

const locatorFor = (identity: VideoIntelligenceJobIdentity): VideoIntelligenceJobLocator => ({
  version: 1,
  sourceVideoMediaId: identity.sourceVideoMediaId,
  sourceVideoContentHash: identity.sourceVideoContentHash,
  analyzerFingerprintSha256: identity.analyzerFingerprint.sha256,
});

const serviceError = (message: string, status: 400 | 404 | 409): never => {
  throw new VideoIntelligenceServiceError(message, status);
};

const validateDeadline = (deadlineAtMs: number) => {
  if (!Number.isSafeInteger(deadlineAtMs)) {
    serviceError('Video intelligence requires a safe server deadline timestamp.', 400);
  }
};

const validateSource = (source: HydratedTraVideoSource, mediaId: string) => {
  if (source.role !== 'TRA_VIDEO' || source.media.id !== mediaId
    || source.media.mediaType !== 'VIDEO' || source.media.mimeType !== 'video/mp4'
    || source.stored.mediaType !== 'VIDEO' || source.stored.mimeType !== 'video/mp4') {
    serviceError('Video intelligence requires a server-hydrated TRA_VIDEO MP4.', 400);
  }
  if (source.stored.buffer.length > MAX_TRANSCRIPTION_UPLOAD_BYTES) {
    serviceError('Video intelligence currently accepts MP4 files up to 25 MB.', 400);
  }
  return source;
};

const defaultHydrateSource = async (mediaId: string): Promise<HydratedTraVideoSource> => {
  const sources = await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId, role: 'TRA_VIDEO' }]);
  return sources[0] as HydratedTraVideoSource;
};

const hydrateSource = async (mediaId: string, dependencies: VideoIntelligenceServiceDependencies) => {
  const source = await (dependencies.hydrateSource ?? defaultHydrateSource)(mediaId);
  return validateSource(source, mediaId);
};

const statusFor = (identity: VideoIntelligenceJobIdentity, job: VideoIntelligenceJob, now: number): CompactVideoIntelligenceJobStatus => ({
  locator: locatorFor(identity),
  jobId: job.id,
  phase: job.phase,
  busy: Boolean(job.lease && job.lease.expiresAtMs > now),
  completedRepresentatives: job.representatives.filter((entry) => entry.thumbnail && entry.observation).length,
  totalRepresentatives: job.preparation?.representativeCandidateIndexes.length ?? null,
  updatedAtMs: job.updatedAtMs,
  ...(job.retry ? { retry: structuredClone(job.retry) } : {}),
  ...(job.failure ? { failure: structuredClone(job.failure) } : {}),
});

export const resolveVideoIntelligenceJobLocator = (locator: unknown): VideoIntelligenceJobIdentity => {
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
    return serviceError('Video intelligence job locator is invalid.', 400);
  }
  const value = locator as Record<string, unknown>;
  if (value.version !== 1 || typeof value.sourceVideoMediaId !== 'string' || !MEDIA_ID.test(value.sourceVideoMediaId)
    || typeof value.sourceVideoContentHash !== 'string' || !SHA256.test(value.sourceVideoContentHash)
    || typeof value.analyzerFingerprintSha256 !== 'string' || !SHA256.test(value.analyzerFingerprintSha256)) {
    return serviceError('Video intelligence job locator is invalid.', 400);
  }
  const identity = currentIdentity(value.sourceVideoMediaId, value.sourceVideoContentHash);
  if (value.analyzerFingerprintSha256 !== identity.analyzerFingerprint.sha256) {
    return serviceError('Video intelligence analyzer settings have changed.', 409);
  }
  return identity;
};

export const resolveExistingVideoIntelligenceJob = async (
  locator: VideoIntelligenceJobLocator,
  dependencies: Pick<VideoIntelligenceServiceDependencies, 'storage' | 'now'>
) => {
  const identity = resolveVideoIntelligenceJobLocator(locator);
  const stored = await readVideoIntelligenceJob(identity, dependencies);
  if (!stored) throw new VideoIntelligenceServiceError('Video intelligence job does not exist.', 404);
  return { identity, job: stored.job };
};

export const readVideoIntelligenceSource = async (
  mediaId: string,
  dependencies: VideoIntelligenceServiceDependencies
): Promise<{ source: CreativeSourceVideoAsset; locator: VideoIntelligenceJobLocator; status: CompactVideoIntelligenceJobStatus | null }> => {
  validateDeadline(dependencies.deadlineAtMs);
  if (!isMediaId(mediaId)) serviceError('Video media ID is invalid.', 400);
  const source = await hydrateSource(mediaId, dependencies);
  const identity = currentIdentity(mediaId, createHash('sha256').update(source.stored.buffer).digest('hex'));
  const stored = await readVideoIntelligenceJob(identity, { storage: dependencies.storage, now: dependencies.now });
  const publicSource: CreativeSourceVideoAsset = { ...source.media, originalName: source.media.fileName };
  return { source: publicSource, locator: locatorFor(identity), status: stored ? statusFor(identity, stored.job, (dependencies.now ?? Date.now)()) : null };
};

const runClaim = async (
  identity: VideoIntelligenceJobIdentity,
  job: VideoIntelligenceJob,
  leaseId: string,
  dependencies: VideoIntelligenceServiceDependencies
) => {
  const runnerDependencies = { storage: dependencies.storage, now: dependencies.now, deadlineAtMs: dependencies.deadlineAtMs, request: dependencies.request };
  switch (job.phase) {
    case 'PREPARING':
      return (dependencies.preparation ?? runVideoIntelligencePreparationJob)(identity, leaseId, await hydrateSource(identity.sourceVideoMediaId, dependencies), runnerDependencies);
    case 'TRANSCRIBING':
      return (dependencies.transcription ?? runVideoIntelligenceTranscriptionJob)(identity, leaseId, await hydrateSource(identity.sourceVideoMediaId, dependencies), runnerDependencies);
    case 'OBSERVING':
      return (dependencies.observation ?? runVideoIntelligenceObservationJob)(identity, leaseId, runnerDependencies);
    case 'FINALIZING':
      return (dependencies.finalization ?? runVideoIntelligenceFinalizationJob)(identity, leaseId, runnerDependencies);
    default:
      return job;
  }
};

export const executeVideoIntelligenceStep = async (
  input: ExecuteVideoIntelligenceStepInput,
  dependencies: VideoIntelligenceServiceDependencies
): Promise<CompactVideoIntelligenceJobStatus> => {
  validateDeadline(dependencies.deadlineAtMs);
  const now = dependencies.now ?? Date.now;
  if (!input || typeof input !== 'object' || !('action' in input)) serviceError('Video intelligence action is invalid.', 400);
  if (input.action === 'START') {
    if (!isMediaId(input.mediaId)) serviceError('Video media ID is invalid.', 400);
    const source = await hydrateSource(input.mediaId, dependencies);
    const identity = currentIdentity(input.mediaId, createHash('sha256').update(source.stored.buffer).digest('hex'));
    const started = await startVideoIntelligenceJob(identity, { storage: dependencies.storage, now: dependencies.now });
    const job = started.created
      ? await (dependencies.preparation ?? runVideoIntelligencePreparationJob)(identity, started.job.lease!.id, source, { storage: dependencies.storage, now: dependencies.now })
      : started.job;
    return statusFor(identity, job, now());
  }
  if (input.action !== 'STATUS' && input.action !== 'ADVANCE' && input.action !== 'RETRY') {
    serviceError('Video intelligence action is invalid.', 400);
  }
  const identity = resolveVideoIntelligenceJobLocator(input.locator);
  if (input.action === 'STATUS') {
    const stored = await readVideoIntelligenceJob(identity, { storage: dependencies.storage, now: dependencies.now });
    if (!stored) throw new VideoIntelligenceServiceError('Video intelligence job does not exist.', 404);
    return statusFor(identity, stored.job, now());
  }
  try {
    const claim = input.action === 'RETRY'
      ? await retryVideoIntelligenceJob(identity, { storage: dependencies.storage, now: dependencies.now, expectedEtag: dependencies.expectedRetryEtag })
      : await claimVideoIntelligenceJob(identity, { storage: dependencies.storage, now: dependencies.now });
    const job = claim.status === 'WORK'
      ? await runClaim(identity, claim.job, claim.leaseId, dependencies)
      : claim.job;
    return statusFor(identity, job, now());
  } catch (error) {
    if (error instanceof Error && error.message === 'Video intelligence job does not exist.') {
      serviceError(error.message, 404);
    }
    throw error;
  }
};
