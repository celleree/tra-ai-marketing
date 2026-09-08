import { randomUUID } from 'node:crypto';
import {
  VIDEO_INTELLIGENCE_JOB_LEASE_MS,
  parseVideoIntelligenceJob,
  videoIntelligenceJobId,
  videoIntelligenceJobKey,
  type VideoIntelligenceJob,
  type VideoIntelligenceJobIdentity,
  type VideoIntelligenceWorkPhase,
} from '@/lib/video/intelligence-job';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const CAS_ATTEMPTS = 4;
type StoredJob = { job: VideoIntelligenceJob; etag: string };
export type VideoIntelligenceJobStoreDependencies = {
  storage?: VideoIntelligenceStorage;
  now?: () => number;
  newLeaseId?: () => string;
};
export type VideoIntelligenceJobClaim =
  | { status: 'WORK'; job: VideoIntelligenceJob; leaseId: string }
  | { status: 'BUSY' | 'COMPLETE' | 'FAILED' | 'RETRY_REQUIRED'; job: VideoIntelligenceJob };

const dependencies = (value: VideoIntelligenceJobStoreDependencies) => ({
  storage: value.storage ?? getVideoIntelligenceStorage(), now: value.now ?? Date.now,
  newLeaseId: value.newLeaseId ?? randomUUID,
});
const copy = <Value>(value: Value): Value => structuredClone(value);
const bytes = (job: VideoIntelligenceJob) => Buffer.from(JSON.stringify(job));
const missing = (job: VideoIntelligenceJob) => job.preparation!.representativeCandidateIndexes.filter((index) => {
  const progress = job.representatives.find((entry) => entry.candidateIndex === index);
  return !progress?.thumbnail || !progress.observation;
});
const lease = (job: VideoIntelligenceJob, phase: VideoIntelligenceWorkPhase, now: number, id: string, candidateIndexes?: number[]) => ({
  ...job, phase, updatedAtMs: now, lease: {
    id, phase, acquiredAtMs: now, expiresAtMs: now + VIDEO_INTELLIGENCE_JOB_LEASE_MS,
    ...(candidateIndexes ? { candidateIndexes: candidateIndexes as [number] | [number, number] } : {}),
  },
} as VideoIntelligenceJob);
const read = async (identity: VideoIntelligenceJobIdentity, storage: VideoIntelligenceStorage): Promise<StoredJob | null> => {
  const stored = await storage.read(videoIntelligenceJobKey(identity));
  return stored && { job: parseVideoIntelligenceJob(stored.bytes, identity), etag: stored.etag };
};
const write = async (identity: VideoIntelligenceJobIdentity, storage: VideoIntelligenceStorage, job: VideoIntelligenceJob, etag: string | null) =>
  storage.write(videoIntelligenceJobKey(identity), bytes(parseVideoIntelligenceJob(bytes(job), identity)), etag);
const requireJob = (job: StoredJob | null) => {
  if (!job) throw new Error('Video intelligence job does not exist.');
  return job;
};
const result = (job: VideoIntelligenceJob): VideoIntelligenceJobClaim => {
  if (job.phase === 'COMPLETE' || job.phase === 'FAILED' || job.phase === 'RETRY_REQUIRED') return { status: job.phase, job };
  if (job.lease) return { status: 'WORK', job, leaseId: job.lease.id };
  throw new Error('Video intelligence job has no claimable lease.');
};
const transitionAllowed = (from: VideoIntelligenceWorkPhase, to: VideoIntelligenceJob['phase']) =>
  (from === 'PREPARING' && (to === 'TRANSCRIBING' || to === 'FAILED'))
  || (from === 'TRANSCRIBING' && (to === 'OBSERVING' || to === 'FAILED' || to === 'RETRY_REQUIRED'))
  || (from === 'OBSERVING' && (to === 'OBSERVING' || to === 'FINALIZING' || to === 'FAILED' || to === 'RETRY_REQUIRED'))
  || (from === 'FINALIZING' && (to === 'COMPLETE' || to === 'FAILED'));
const sameLease = (left: VideoIntelligenceJob['lease'], right: VideoIntelligenceJob['lease']) =>
  left !== null && right !== null && left.id === right.id && left.phase === right.phase
  && left.acquiredAtMs === right.acquiredAtMs && left.expiresAtMs === right.expiresAtMs
  && JSON.stringify(left.candidateIndexes) === JSON.stringify(right.candidateIndexes);
const preservesSavedWork = (current: VideoIntelligenceJob, next: VideoIntelligenceJob) =>
  (!current.preparation || JSON.stringify(current.preparation) === JSON.stringify(next.preparation))
  && (!current.transcript || JSON.stringify(current.transcript) === JSON.stringify(next.transcript))
  && current.representatives.every((entry) => next.representatives.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)));

/** Internal read includes the storage ETag; public claim/checkpoint results never do. */
export const readVideoIntelligenceJob = async (identity: VideoIntelligenceJobIdentity, value: VideoIntelligenceJobStoreDependencies = {}) => {
  const deps = dependencies(value); videoIntelligenceJobKey(identity);
  return read(identity, deps.storage);
};

export const startVideoIntelligenceJob = async (identity: VideoIntelligenceJobIdentity, value: VideoIntelligenceJobStoreDependencies = {}) => {
  const deps = dependencies(value); const key = videoIntelligenceJobKey(identity);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const now = deps.now();
    const job: VideoIntelligenceJob = {
      version: 1, artifactType: 'VIDEO_INTELLIGENCE_JOB', providerEligible: false,
      id: videoIntelligenceJobId(identity), sourceVideoMediaId: identity.sourceVideoMediaId,
      sourceVideoContentHash: identity.sourceVideoContentHash, analyzerFingerprint: copy(identity.analyzerFingerprint),
      phase: 'PREPARING', representatives: [], lease: { id: deps.newLeaseId(), phase: 'PREPARING', acquiredAtMs: now, expiresAtMs: now + VIDEO_INTELLIGENCE_JOB_LEASE_MS },
      createdAtMs: now, updatedAtMs: now,
    };
    if (await write(identity, deps.storage, job, null)) return { created: true, job };
    const existing = await read(identity, deps.storage);
    if (existing) return { created: false, job: existing.job };
  }
  throw new Error(`Video intelligence job contention while creating ${key}.`);
};

export const claimVideoIntelligenceJob = async (identity: VideoIntelligenceJobIdentity, value: VideoIntelligenceJobStoreDependencies = {}): Promise<VideoIntelligenceJobClaim> => {
  const deps = dependencies(value); videoIntelligenceJobKey(identity);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = requireJob(await read(identity, deps.storage)); const now = deps.now(); const job = current.job;
    if (job.phase === 'COMPLETE' || job.phase === 'FAILED' || job.phase === 'RETRY_REQUIRED') return result(job);
    if (job.lease && job.lease.expiresAtMs > now) return { status: 'BUSY', job };
    let next: VideoIntelligenceJob;
    const expiredObservationIndexes = job.lease?.phase === 'OBSERVING'
      ? job.lease.candidateIndexes!.filter((index) => missing(job).includes(index)) : undefined;
    if (job.lease && job.phase === 'OBSERVING' && missing(job).length === 0) {
      next = lease(job, 'FINALIZING', now, deps.newLeaseId());
    } else if (job.lease && job.phase === 'OBSERVING' && expiredObservationIndexes?.length === 0) {
      next = { ...job, lease: null, updatedAtMs: now };
    } else if (job.lease && (job.phase === 'TRANSCRIBING' || job.phase === 'OBSERVING')) {
      next = { ...job, phase: 'RETRY_REQUIRED', lease: null, updatedAtMs: now, retry: {
        phase: job.phase, reason: 'LEASE_EXPIRED', ...(job.phase === 'OBSERVING' ? { candidateIndexes: expiredObservationIndexes! as [number] | [number, number] } : {}),
      } };
    } else if (job.phase === 'OBSERVING') {
      const candidateIndexes = missing(job).slice(0, 2);
      next = candidateIndexes.length ? lease(job, 'OBSERVING', now, deps.newLeaseId(), candidateIndexes) : lease(job, 'FINALIZING', now, deps.newLeaseId());
    } else next = lease(job, job.phase, now, deps.newLeaseId());
    if (await write(identity, deps.storage, next, current.etag)) {
      if (next.phase === 'OBSERVING' && !next.lease) continue;
      return result(next);
    }
  }
  throw new Error('Video intelligence job contention while claiming work.');
};

export const retryVideoIntelligenceJob = async (identity: VideoIntelligenceJobIdentity, value: VideoIntelligenceJobStoreDependencies = {}): Promise<VideoIntelligenceJobClaim> => {
  const deps = dependencies(value); videoIntelligenceJobKey(identity);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = requireJob(await read(identity, deps.storage));
    if (current.job.phase !== 'RETRY_REQUIRED') {
      return current.job.phase === 'COMPLETE' || current.job.phase === 'FAILED'
        ? result(current.job) : { status: 'BUSY', job: current.job };
    }
    const retry = current.job.retry!; const now = deps.now();
    const candidateIndexes = retry.phase === 'OBSERVING' ? missing(current.job).slice(0, 2) : undefined;
    const next = candidateIndexes?.length === 0
      ? lease({ ...current.job, retry: undefined }, 'FINALIZING', now, deps.newLeaseId())
      : lease({ ...current.job, retry: undefined }, retry.phase, now, deps.newLeaseId(), candidateIndexes ?? retry.candidateIndexes);
    if (await write(identity, deps.storage, next, current.etag)) return result(next);
  }
  throw new Error('Video intelligence job contention while retrying work.');
};

export const checkpointVideoIntelligenceJob = async (
  identity: VideoIntelligenceJobIdentity,
  leaseId: string,
  updateCurrentJob: (current: VideoIntelligenceJob) => VideoIntelligenceJob,
  value: VideoIntelligenceJobStoreDependencies = {}
) => {
  const deps = dependencies(value); videoIntelligenceJobKey(identity);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = requireJob(await read(identity, deps.storage)); const active = current.job.lease;
    if (!active || active.id !== leaseId || active.phase !== current.job.phase) throw new Error('Video intelligence job lease is no longer current.');
    const next = updateCurrentJob(copy(current.job));
    if (next.createdAtMs !== current.job.createdAtMs || !transitionAllowed(active.phase, next.phase)) throw new Error('Video intelligence job checkpoint transition is invalid.');
    if (next.lease && !sameLease(next.lease, active)) throw new Error('Video intelligence job checkpoint may not change a lease.');
    if (!preservesSavedWork(current.job, next)) throw new Error('Video intelligence job checkpoint may not erase saved work.');
    next.updatedAtMs = deps.now(); parseVideoIntelligenceJob(bytes(next), identity);
    if (await write(identity, deps.storage, next, current.etag)) return next;
  }
  throw new Error('Video intelligence job contention while checkpointing work.');
};
