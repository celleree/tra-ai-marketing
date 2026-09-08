import { createHash } from 'node:crypto';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoIntelligenceJob, VideoIntelligenceJobIdentity } from '@/lib/video/intelligence-job';
import {
  checkpointVideoIntelligenceJob,
  readVideoIntelligenceJob,
  VideoIntelligenceJobLeaseLostError,
} from '@/lib/video/intelligence-job-store';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { transcribeTraVideo, VIDEO_TRANSCRIPTION_TIMEOUT_MS } from '@/lib/video/transcript';

const CHECKPOINT_RESERVE_MS = 65_000;
const RETRY_MESSAGE_MAX_LENGTH = 2_000;

export interface VideoIntelligenceTranscriptionRunnerDependencies {
  deadlineAtMs: number;
  storage?: VideoIntelligenceStorage;
  now?: () => number;
  request?: typeof fetch;
}

const sourceHash = (source: HydratedTraVideoSource) =>
  createHash('sha256').update(source.stored.buffer).digest('hex');

const validateSource = (
  source: HydratedTraVideoSource,
  job: VideoIntelligenceJob,
  identity: VideoIntelligenceJobIdentity
) => {
  const contentHash = sourceHash(source);
  if (
    source.role !== 'TRA_VIDEO'
    || source.media.id !== job.sourceVideoMediaId
    || source.media.id !== identity.sourceVideoMediaId
    || source.media.mediaType !== 'VIDEO'
    || source.media.mimeType !== 'video/mp4'
    || source.stored.mediaType !== 'VIDEO'
    || source.stored.mimeType !== 'video/mp4'
    || contentHash !== job.sourceVideoContentHash
    || contentHash !== identity.sourceVideoContentHash
  ) {
    throw new Error('Video intelligence transcription requires the matching hydrated TRA_VIDEO MP4.');
  }
};

const retryMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Video transcription failed.';
  return message.slice(0, RETRY_MESSAGE_MAX_LENGTH);
};

export const runVideoIntelligenceTranscriptionJob = async (
  identity: VideoIntelligenceJobIdentity,
  leaseId: string,
  source: HydratedTraVideoSource,
  dependencies: VideoIntelligenceTranscriptionRunnerDependencies
): Promise<VideoIntelligenceJob> => {
  if (!Number.isSafeInteger(dependencies.deadlineAtMs)) {
    throw new Error('Video intelligence transcription requires a safe server deadline timestamp.');
  }
  const storeDependencies = { storage: dependencies.storage, now: dependencies.now };
  const current = await readVideoIntelligenceJob(identity, storeDependencies);
  if (!current || current.job.phase !== 'TRANSCRIBING' || current.job.lease?.id !== leaseId) {
    throw new VideoIntelligenceJobLeaseLostError();
  }

  validateSource(source, current.job, identity);
  const retry = (message: string) => checkpointVideoIntelligenceJob(
    identity,
    leaseId,
    (job) => ({
      ...job,
      phase: 'RETRY_REQUIRED',
      lease: null,
      retry: { phase: 'TRANSCRIBING', reason: 'PAID_WORK_FAILED', message },
    }),
    storeDependencies
  );
  const effectiveDeadlineAtMs = Math.min(dependencies.deadlineAtMs, current.job.lease.expiresAtMs);
  const remainingMs = effectiveDeadlineAtMs - (dependencies.now ?? Date.now)();
  if (remainingMs < VIDEO_TRANSCRIPTION_TIMEOUT_MS + CHECKPOINT_RESERVE_MS) {
    return retry('Video transcription request not started: insufficient time remaining before the server or lease deadline.');
  }

  let transcript;
  try {
    transcript = await transcribeTraVideo(source, current.job.preparation!.durationMs, { request: dependencies.request });
  } catch (error) {
    return retry(retryMessage(error));
  }
  return checkpointVideoIntelligenceJob(
    identity,
    leaseId,
    (job) => ({ ...job, phase: 'OBSERVING', transcript, lease: null }),
    storeDependencies
  );
};
