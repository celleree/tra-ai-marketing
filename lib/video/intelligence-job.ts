import { createHash } from 'node:crypto';
import { getJpegDimensions } from '@/lib/video/candidate-file-integrity';
import { HARD_MAX_TOTAL_CANDIDATES } from '@/lib/video/candidate-policy';
import {
  createVideoIntelligenceAnalyzerFingerprint,
  type VideoIntelligenceAnalyzerFingerprint,
} from '@/lib/video/intelligence-preparation';
import type { VideoFrameThumbnail } from '@/lib/video/frame-thumbnail';
import type { VideoTranscript } from '@/lib/video/transcript';
import {
  observeVideoFrameBytes,
  parseFrameVisualObservation,
} from '@/lib/video/visual-observation';

export const MAX_VIDEO_INTELLIGENCE_JOB_BYTES = 32 * 1024 * 1024;
export const VIDEO_INTELLIGENCE_JOB_LEASE_MS = 5 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_ID = /^media_[a-f0-9]{32}$/;
const WORK_PHASES = ['PREPARING', 'TRANSCRIBING', 'OBSERVING', 'FINALIZING'] as const;
const PHASES = [...WORK_PHASES, 'COMPLETE', 'FAILED', 'RETRY_REQUIRED'] as const;
const RETRY_REASONS = ['LEASE_EXPIRED', 'PAID_WORK_FAILED', 'PAID_COMPLETION_UNCERTAIN'] as const;

export type VideoIntelligenceWorkPhase = typeof WORK_PHASES[number];
export type VideoIntelligenceJobPhase = typeof PHASES[number];
export type VideoIntelligenceFrameObservation = Awaited<ReturnType<typeof observeVideoFrameBytes>>;
export interface VideoIntelligenceJobIdentity {
  sourceVideoMediaId: string;
  sourceVideoContentHash: string;
  analyzerFingerprint: VideoIntelligenceAnalyzerFingerprint;
}
export interface VideoIntelligenceJobLease {
  id: string;
  phase: VideoIntelligenceWorkPhase;
  candidateIndexes?: [number] | [number, number];
  acquiredAtMs: number;
  expiresAtMs: number;
}
export interface VideoIntelligenceJobRetry {
  phase: 'TRANSCRIBING' | 'OBSERVING';
  candidateIndexes?: [number] | [number, number];
  reason: typeof RETRY_REASONS[number];
  message?: string;
}
export interface VideoIntelligenceArtifactReference {
  key: string;
  sha256: string;
  byteLength: number;
}
export interface VideoIntelligenceRepresentativeProgress {
  candidateIndex: number;
  frameSha256: string;
  thumbnail?: VideoFrameThumbnail;
  observation?: VideoIntelligenceFrameObservation;
}
export interface VideoIntelligenceJob {
  version: 1;
  artifactType: 'VIDEO_INTELLIGENCE_JOB';
  providerEligible: false;
  id: string;
  sourceVideoMediaId: string;
  sourceVideoContentHash: string;
  analyzerFingerprint: VideoIntelligenceAnalyzerFingerprint;
  phase: VideoIntelligenceJobPhase;
  preparation?: {
    manifestKey: string;
    manifestSha256: string;
    durationMs: number;
    representativeCandidateIndexes: number[];
  };
  transcript?: VideoTranscript;
  representatives: VideoIntelligenceRepresentativeProgress[];
  result?: VideoIntelligenceArtifactReference;
  lease: VideoIntelligenceJobLease | null;
  retry?: VideoIntelligenceJobRetry;
  failure?: { phase: VideoIntelligenceWorkPhase; message: string };
  createdAtMs: number;
  updatedAtMs: number;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const reject = (reason: string): never => {
  throw new Error(`Video intelligence job rejected: ${reason}`);
};
const validateFingerprint = (value: unknown): VideoIntelligenceAnalyzerFingerprint => {
  if (!isRecord(value) || !isRecord(value.candidatePolicy) || typeof value.visionModel !== 'string') {
    return reject('analyzer fingerprint is invalid.');
  }
  const candidatePolicy = value.candidatePolicy;
  let expected: VideoIntelligenceAnalyzerFingerprint;
  try {
    expected = createVideoIntelligenceAnalyzerFingerprint(
      candidatePolicy as unknown as VideoIntelligenceAnalyzerFingerprint['candidatePolicy'],
      value.visionModel
    );
  } catch {
    return reject('analyzer fingerprint is invalid.');
  }
  if (value.pipelineVersion !== expected.pipelineVersion
    || value.transcriptionModel !== expected.transcriptionModel
    || value.sha256 !== expected.sha256
    || Object.entries(expected.candidatePolicy).some(([key, setting]) => candidatePolicy[key] !== setting)) {
    return reject('analyzer fingerprint does not match its settings.');
  }
  return value as unknown as VideoIntelligenceAnalyzerFingerprint;
};
const validateIdentity = (identity: VideoIntelligenceJobIdentity) => {
  if (!MEDIA_ID.test(identity.sourceVideoMediaId) || !SHA256.test(identity.sourceVideoContentHash)) {
    reject('source identity is invalid.');
  }
  validateFingerprint(identity.analyzerFingerprint);
  return identity;
};
const jobDigest = (identity: VideoIntelligenceJobIdentity) => {
  validateIdentity(identity);
  return createHash('sha256').update(JSON.stringify([
    1,
    identity.sourceVideoMediaId,
    identity.sourceVideoContentHash,
    identity.analyzerFingerprint.sha256,
  ])).digest('hex');
};
export const videoIntelligenceJobId = (identity: VideoIntelligenceJobIdentity) =>
  `video-intelligence-job:${jobDigest(identity)}`;
export const videoIntelligenceJobKey = (identity: VideoIntelligenceJobIdentity) =>
  `jobs/sha256/${jobDigest(identity)}.json`;
const validateIndexes = (value: unknown, expected?: ReadonlySet<number>) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > HARD_MAX_TOTAL_CANDIDATES) {
    return reject('representative candidate indexes are invalid.');
  }
  let previous = -1;
  for (const index of value) {
    if (!isSafeInteger(index) || index < 0 || index <= previous || (expected && !expected.has(index))) {
      return reject('representative candidate indexes are invalid.');
    }
    previous = index;
  }
  return value as number[];
};
const validatePreparation = (value: unknown) => {
  if (!isRecord(value) || !SHA256.test(String(value.manifestSha256))
    || value.manifestKey !== `preparations/manifests/sha256/${value.manifestSha256}.json`
    || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs <= 0) {
    return reject('preparation reference is invalid.');
  }
  return {
    ...value,
    representativeCandidateIndexes: validateIndexes(value.representativeCandidateIndexes),
  } as unknown as NonNullable<VideoIntelligenceJob['preparation']>;
};
const validateTranscript = (value: unknown, job: VideoIntelligenceJob, durationMs: number) => {
  if (!isRecord(value) || value.version !== 1 || value.model !== 'whisper-1'
    || value.sourceVideoMediaId !== job.sourceVideoMediaId
    || value.sourceVideoContentHash !== job.sourceVideoContentHash
    || typeof value.language !== 'string' || !Array.isArray(value.segments)) {
    return reject('transcript is invalid.');
  }
  let previousStart = -1;
  value.segments.forEach((segment, index) => {
    if (!isRecord(segment) || segment.segmentIndex !== index
      || typeof segment.startMs !== 'number' || !Number.isFinite(segment.startMs) || segment.startMs < previousStart
      || typeof segment.endMs !== 'number' || !Number.isFinite(segment.endMs)
      || segment.startMs < 0 || segment.endMs <= segment.startMs || segment.endMs > durationMs
      || typeof segment.text !== 'string' || !segment.text.trim()) {
      reject('transcript segment is invalid.');
    }
    previousStart = segment.startMs;
  });
};
const validateThumbnail = (
  value: unknown,
  job: VideoIntelligenceJob,
  candidateIndex: number,
  frameSha256: string,
  durationMs: number
) => {
  if (!isRecord(value) || value.sourceVideoMediaId !== job.sourceVideoMediaId
    || value.sourceVideoContentHash !== job.sourceVideoContentHash || value.candidateIndex !== candidateIndex
    || value.frameSha256 !== frameSha256 || typeof value.timestampMs !== 'number'
    || !Number.isFinite(value.timestampMs) || value.timestampMs < 0 || value.timestampMs >= durationMs
    || typeof value.thumbnailDataUrl !== 'string') return reject('representative thumbnail is invalid.');
  const encoded = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.thumbnailDataUrl)?.[1];
  const dimensions = encoded ? getJpegDimensions(Buffer.from(encoded, 'base64')) : null;
  if (!dimensions || dimensions.width < 1 || dimensions.width > 280 || dimensions.height < 1) {
    reject('representative thumbnail is invalid.');
  }
};
const validateObservation = (
  value: unknown,
  job: VideoIntelligenceJob,
  candidateIndex: number,
  frameSha256: string,
  timestampMs: number
) => {
  if (!isRecord(value) || value.version !== 1 || value.model !== job.analyzerFingerprint.visionModel
    || value.providerEligible !== false || value.evidenceStatus !== 'UNVERIFIED_MODEL_OBSERVATION'
    || value.sourceVideoMediaId !== job.sourceVideoMediaId || value.sourceVideoContentHash !== job.sourceVideoContentHash
    || value.candidateIndex !== candidateIndex || value.frameSha256 !== frameSha256 || value.timestampMs !== timestampMs) {
    return reject('representative observation is invalid.');
  }
  try { parseFrameVisualObservation(value.observation); } catch { reject('representative observation is invalid.'); }
};
const validateOptionalWork = (value: unknown, name: string) => {
  if (value !== undefined && (!isRecord(value) || !WORK_PHASES.includes(value.phase as VideoIntelligenceWorkPhase))) {
    reject(`${name} is invalid.`);
  }
  return value as Record<string, unknown> | undefined;
};

const validatePairIndexes = (value: unknown, expected?: ReadonlySet<number>) => {
  const indexes = validateIndexes(value, expected);
  if (indexes.length > 2) reject('paid work may claim at most two candidates.');
  return indexes;
};

export const parseVideoIntelligenceJob = (
  bytes: Buffer,
  expectedIdentity: VideoIntelligenceJobIdentity
): VideoIntelligenceJob => {
  if (bytes.length < 1 || bytes.length > MAX_VIDEO_INTELLIGENCE_JOB_BYTES) reject('serialized size is invalid.');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return reject('JSON is invalid.'); }
  if (!isRecord(value)) return reject('record is invalid.');
  const identity = validateIdentity(expectedIdentity);
  const job = value as unknown as VideoIntelligenceJob;
  if (job.version !== 1 || job.artifactType !== 'VIDEO_INTELLIGENCE_JOB' || job.providerEligible !== false
    || job.id !== videoIntelligenceJobId(identity) || job.sourceVideoMediaId !== identity.sourceVideoMediaId
    || job.sourceVideoContentHash !== identity.sourceVideoContentHash || !PHASES.includes(job.phase)
    || !Array.isArray(job.representatives) || job.representatives.length > HARD_MAX_TOTAL_CANDIDATES
    || (job.lease !== null && !isRecord(job.lease))
    || !isSafeInteger(job.createdAtMs) || job.createdAtMs < 0
    || !isSafeInteger(job.updatedAtMs) || job.updatedAtMs < job.createdAtMs) return reject('record identity or metadata is invalid.');
  const fingerprint = validateFingerprint(job.analyzerFingerprint);
  if (fingerprint.sha256 !== identity.analyzerFingerprint.sha256) reject('record analyzer identity is invalid.');

  const preparation = job.preparation && validatePreparation(job.preparation);
  const expectedIndexes = preparation && new Set(preparation.representativeCandidateIndexes);
  if (job.transcript && preparation) {
    validateTranscript(job.transcript, job, preparation.durationMs);
  } else if (job.transcript) {
    reject('transcript requires preparation.');
  }
  let previousIndex = -1;
  for (const entry of job.representatives) {
    if (!preparation || !isRecord(entry) || !isSafeInteger(entry.candidateIndex)
      || entry.candidateIndex <= previousIndex || !expectedIndexes!.has(entry.candidateIndex)
      || typeof entry.frameSha256 !== 'string' || !SHA256.test(entry.frameSha256)) {
      return reject('representative progress is invalid.');
    }
    const thumbnail = entry.thumbnail;
    if (thumbnail) validateThumbnail(thumbnail, job, entry.candidateIndex, entry.frameSha256, preparation.durationMs);
    if (entry.observation) {
      if (!job.transcript || !thumbnail) return reject('observation requires transcript and thumbnail.');
      validateObservation(entry.observation, job, entry.candidateIndex, entry.frameSha256, thumbnail.timestampMs);
    }
    previousIndex = entry.candidateIndex;
  }

  const lease = validateOptionalWork(job.lease ?? undefined, 'lease');
  if (lease) {
    if (lease.phase !== job.phase || typeof lease.id !== 'string' || !lease.id
      || !isSafeInteger(lease.acquiredAtMs) || !isSafeInteger(lease.expiresAtMs)
      || lease.expiresAtMs - lease.acquiredAtMs !== VIDEO_INTELLIGENCE_JOB_LEASE_MS) reject('lease is invalid.');
    if (lease.phase === 'OBSERVING') validatePairIndexes(lease.candidateIndexes, expectedIndexes);
    else if (lease.candidateIndexes !== undefined) reject('only observation leases may name candidates.');
  }
  const retry = validateOptionalWork(job.retry, 'retry');
  if (retry) {
    if (job.phase !== 'RETRY_REQUIRED' || (retry.phase !== 'TRANSCRIBING' && retry.phase !== 'OBSERVING')
      || !RETRY_REASONS.includes(retry.reason as VideoIntelligenceJobRetry['reason'])
      || (retry.message !== undefined && (typeof retry.message !== 'string' || retry.message.length > 2_000))) reject('retry is invalid.');
    if (retry.phase === 'OBSERVING') validatePairIndexes(retry.candidateIndexes, expectedIndexes);
    else if (retry.candidateIndexes !== undefined) reject('transcription retry may not name candidates.');
    if (!preparation || (retry.phase === 'TRANSCRIBING' && (job.transcript || job.representatives.length))
      || (retry.phase === 'OBSERVING' && !job.transcript)) reject('retry prerequisites are invalid.');
  }
  const failure = validateOptionalWork(job.failure, 'failure');
  if (failure && (job.phase !== 'FAILED' || typeof failure.message !== 'string'
    || !failure.message || failure.message.length > 2_000)) reject('failure is invalid.');

  const completeRepresentatives = preparation?.representativeCandidateIndexes.every((candidateIndex) => {
    const entry = job.representatives.find((candidate) => candidate.candidateIndex === candidateIndex);
    return Boolean(entry?.thumbnail && entry.observation);
  });
  if (job.phase === 'PREPARING' && (preparation || job.transcript || job.representatives.length)) reject('preparing state is invalid.');
  if (job.phase === 'TRANSCRIBING' && (!preparation || job.transcript || job.representatives.length)) reject('transcribing state is invalid.');
  if (job.phase === 'OBSERVING' && (!preparation || !job.transcript)) reject('observing state is invalid.');
  if (job.phase === 'FINALIZING' && (!preparation || !job.transcript || !completeRepresentatives)) reject('finalizing state is invalid.');
  if (job.phase === 'COMPLETE') {
    if (!completeRepresentatives || !isRecord(job.result) || !SHA256.test(String(job.result.sha256))
      || job.result.key !== `libraries/sha256/${job.result.sha256}.json`
      || !isSafeInteger(job.result.byteLength) || job.result.byteLength < 1) reject('complete result is invalid.');
  } else if (job.result !== undefined) reject('only a complete job may have a result.');
  if ((job.phase === 'COMPLETE' || job.phase === 'FAILED' || job.phase === 'RETRY_REQUIRED') && job.lease !== null) reject('terminal or retry state may not have a lease.');
  if ((job.phase === 'FAILED') !== Boolean(failure) || (job.phase === 'RETRY_REQUIRED') !== Boolean(retry)) reject('failure or retry state is invalid.');
  if (job.phase !== 'FAILED' && job.failure !== undefined) reject('only failed jobs may have a failure.');
  if (job.phase !== 'RETRY_REQUIRED' && job.retry !== undefined) reject('only retry-required jobs may have retry metadata.');
  return job;
};
