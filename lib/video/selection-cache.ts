import { emitProviderReuse } from '@/lib/ai/provider-telemetry';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeVideoSelectionPool, parsePooledVideoConceptSelection, parseVideoConceptSelection, selectVideoFramesForConcept,
  selectVideoFramesForConceptPool, VIDEO_SELECTION_TIMEOUT_MS, type VideoConceptSelection, type VideoSelectionPoolBinding } from '@/lib/video/concept-selection';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { HUMAN_FRAME_SELECTION_POLICY, canonicalizeVideoFrameReuseContext, canonicalizeVideoHumanSelectionPool,
  parseVideoHumanFrameSelectionOutcome, requireVisualSelectionOutputBudget, selectVideoHumanFrameFromPool, type VideoFrameReuseContext,
  type VideoHumanFrameSelectionOutcome, type VideoHumanSelectionPoolBinding } from '@/lib/video/human-frame-selection';

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_VISUAL_RECORD_BYTES = 2 * 1024 * 1024;
const LEASE_MS = 5 * 60 * 1000;
type RetryReason = 'LEASE_EXPIRED' | 'PROVIDER_FAILED' | 'INSUFFICIENT_TIME';
type CacheRecord = { version: 1; librarySha256: string; model: string; concept: string } & (
  | { status: 'RUNNING'; lease: { id: string; expiresAtMs: number } }
  | { status: 'RETRY_REQUIRED'; reason: RetryReason }
  | { status: 'COMPLETE'; selection: VideoConceptSelection }
);
type PoolIdentityEntry = { libraryId: string; sourceVideoMediaId: string; sourceVideoContentHash: string; librarySha256: string };
type PoolCacheRecord = { version: 2; libraries: PoolIdentityEntry[]; model: string; concept: string } & (
  | { status: 'RUNNING'; lease: { id: string; expiresAtMs: number } }
  | { status: 'RETRY_REQUIRED'; reason: RetryReason }
  | { status: 'COMPLETE'; selection: VideoConceptSelection }
);
type VisualPoolIdentityEntry = PoolIdentityEntry & { frames: Array<{
  frameId: string; candidateIndex: number; timestampMs: number; frameSha256: string; width: number; height: number;
}> };
type VisualPoolCacheRecord = { version: 3; policy: typeof HUMAN_FRAME_SELECTION_POLICY; libraries: VisualPoolIdentityEntry[];
  reuseContext: VideoFrameReuseContext; model: string; concept: string } & (
  | { status: 'RUNNING'; lease: { id: string; expiresAtMs: number } }
  | { status: 'RETRY_REQUIRED'; reason: RetryReason }
  | { status: 'COMPLETE'; outcome: VideoHumanFrameSelectionOutcome }
);
export type CachedVideoSelectionResult = { status: 'BUSY' }
  | { status: 'RETRY_REQUIRED'; reason: RetryReason }
  | { status: 'COMPLETE'; selection: VideoConceptSelection };
export type CachedVideoHumanSelectionResult = { status: 'BUSY' }
  | { status: 'RETRY_REQUIRED'; reason: RetryReason }
  | { status: 'COMPLETE'; outcome: VideoHumanFrameSelectionOutcome };
export interface VideoSelectionCacheDependencies {
  model: string;
  deadlineAtMs: number;
  retry?: boolean;
  storage?: VideoIntelligenceStorage;
  now?: () => number;
  newLeaseId?: () => string;
  request?: typeof fetch;
}

/** Caller supplies a library validated by loadVideoIntelligenceLibrary and its immutable artifact digest. */
export const selectVideoFramesWithCache = async (
  library: VideoFrameLibrary,
  librarySha256: string,
  concept: string,
  dependencies: VideoSelectionCacheDependencies
): Promise<CachedVideoSelectionResult> => {
  const brief = concept.trim(); const model = dependencies.model.trim();
  if (!brief || brief.length > 2_000 || !model || !/^[a-f0-9]{64}$/.test(librarySha256)
    || !Number.isSafeInteger(dependencies.deadlineAtMs)) throw new Error('Video selection cache input is invalid.');
  const storage = dependencies.storage ?? getVideoIntelligenceStorage(); const now = dependencies.now ?? Date.now;
  const identity = { version: 1 as const, librarySha256, model, concept: brief };
  const digest = createHash('sha256').update(JSON.stringify([1, librarySha256, brief, model])).digest('hex');
  const key = `selections/sha256/${digest}.json`;
  const read = async () => {
    const stored = await storage.read(key); if (!stored) return null;
    if (stored.bytes.length > MAX_RECORD_BYTES) throw new Error('Video selection cache exceeds its size limit.');
    const value = JSON.parse(stored.bytes.toString('utf8')) as CacheRecord;
    if (!value || value.version !== 1 || value.librarySha256 !== librarySha256 || value.model !== model || value.concept !== brief) {
      throw new Error('Video selection cache identity is invalid.');
    }
    if (value.status === 'COMPLETE') value.selection = parseVideoConceptSelection(value.selection, library, brief);
    else if (value.status === 'RUNNING') {
      if (!value.lease || typeof value.lease.id !== 'string' || !value.lease.id
        || !Number.isSafeInteger(value.lease.expiresAtMs)) throw new Error('Video selection cache lease is invalid.');
    } else if (value.status !== 'RETRY_REQUIRED' || !['LEASE_EXPIRED', 'PROVIDER_FAILED', 'INSUFFICIENT_TIME'].includes(value.reason)) {
      throw new Error('Video selection cache state is invalid.');
    }
    return { value, etag: stored.etag };
  };
  const write = (value: CacheRecord, etag: string | null) => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('Video selection cache exceeds its size limit.');
    return storage.write(key, bytes, etag);
  };
  let owned: Extract<CacheRecord, { status: 'RUNNING' }> | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await read(); const value = current?.value;
    if (value?.status === 'COMPLETE') { emitProviderReuse('video-concept-selection', model); return { status: 'COMPLETE', selection: value.selection }; }
    if (value?.status === 'RUNNING' && value.lease.expiresAtMs > now()) return { status: 'BUSY' };
    if (value?.status === 'RETRY_REQUIRED' && !dependencies.retry) return { status: value.status, reason: value.reason };
    if (value?.status === 'RUNNING' && !dependencies.retry) {
      const failed = { ...identity, status: 'RETRY_REQUIRED' as const, reason: 'LEASE_EXPIRED' as const };
      if (await write(failed, current!.etag)) return { status: failed.status, reason: failed.reason };
      continue;
    }
    const next = { ...identity, status: 'RUNNING' as const, lease: {
      id: (dependencies.newLeaseId ?? randomUUID)(), expiresAtMs: now() + LEASE_MS,
    } };
    if (await write(next, current?.etag ?? null)) { owned = next; break; }
  }
  if (!owned) throw new Error('Video selection cache contention while claiming work.');
  const checkpoint = async (next: Exclude<CacheRecord, { status: 'RUNNING' }>): Promise<CachedVideoSelectionResult> => {
    const current = await read();
    if (current?.value.status !== 'RUNNING' || current.value.lease.id !== owned!.lease.id
      || !await write(next, current.etag)) throw new Error('Video selection lease is no longer current.');
    return next.status === 'COMPLETE' ? { status: next.status, selection: next.selection } : { status: next.status, reason: next.reason };
  };
  if (Math.min(dependencies.deadlineAtMs, owned.lease.expiresAtMs) - now() < VIDEO_SELECTION_TIMEOUT_MS + 65_000) {
    return checkpoint({ ...identity, status: 'RETRY_REQUIRED', reason: 'INSUFFICIENT_TIME' });
  }
  let selection: VideoConceptSelection;
  try { selection = await selectVideoFramesForConcept(library, brief, { model, request: dependencies.request }); }
  catch { return checkpoint({ ...identity, status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' }); }
  // Post-provider checkpoint failures propagate; never automatically repeat paid work.
  return checkpoint({ ...identity, status: 'COMPLETE', selection });
};

/** Caller supplies completed libraries validated by loadVideoIntelligenceLibrary and each immutable artifact digest. */
export const selectVideoFramesFromPoolWithCache = async (
  bindings: readonly VideoSelectionPoolBinding[],
  concept: string,
  dependencies: VideoSelectionCacheDependencies
): Promise<CachedVideoSelectionResult> => {
  const brief = concept.trim(); const model = dependencies.model.trim();
  if (!brief || brief.length > 2_000 || !model || !Number.isSafeInteger(dependencies.deadlineAtMs)) {
    throw new Error('Video selection cache input is invalid.');
  }
  const pool = canonicalizeVideoSelectionPool(bindings);
  const libraries: PoolIdentityEntry[] = pool.map(({ library, librarySha256 }) => ({
    libraryId: library.id, sourceVideoMediaId: library.sourceVideoMediaId,
    sourceVideoContentHash: library.sourceVideoContentHash, librarySha256,
  }));
  const storage = dependencies.storage ?? getVideoIntelligenceStorage(); const now = dependencies.now ?? Date.now;
  const identity = { version: 2 as const, libraries, model, concept: brief };
  const digest = createHash('sha256').update(JSON.stringify([2, libraries, brief, model])).digest('hex');
  const key = `selections/sha256/${digest}.json`;
  const read = async () => {
    const stored = await storage.read(key); if (!stored) return null;
    if (stored.bytes.length > MAX_RECORD_BYTES) throw new Error('Video selection cache exceeds its size limit.');
    const value = JSON.parse(stored.bytes.toString('utf8')) as PoolCacheRecord;
    if (!value || value.version !== 2 || value.model !== model || value.concept !== brief
      || JSON.stringify(value.libraries) !== JSON.stringify(libraries)) throw new Error('Video selection cache identity is invalid.');
    if (value.status === 'COMPLETE') value.selection = parsePooledVideoConceptSelection(value.selection, pool, brief);
    else if (value.status === 'RUNNING') {
      if (!value.lease || typeof value.lease.id !== 'string' || !value.lease.id
        || !Number.isSafeInteger(value.lease.expiresAtMs)) throw new Error('Video selection cache lease is invalid.');
    } else if (value.status !== 'RETRY_REQUIRED' || !['LEASE_EXPIRED', 'PROVIDER_FAILED', 'INSUFFICIENT_TIME'].includes(value.reason)) {
      throw new Error('Video selection cache state is invalid.');
    }
    return { value, etag: stored.etag };
  };
  const write = (value: PoolCacheRecord, etag: string | null) => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('Video selection cache exceeds its size limit.');
    return storage.write(key, bytes, etag);
  };
  let owned: Extract<PoolCacheRecord, { status: 'RUNNING' }> | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await read(); const value = current?.value;
    if (value?.status === 'COMPLETE') { emitProviderReuse('video-pool-selection', model); return { status: 'COMPLETE', selection: value.selection }; }
    if (value?.status === 'RUNNING' && value.lease.expiresAtMs > now()) return { status: 'BUSY' };
    if (value?.status === 'RETRY_REQUIRED' && !dependencies.retry) return { status: value.status, reason: value.reason };
    if (value?.status === 'RUNNING' && !dependencies.retry) {
      const failed = { ...identity, status: 'RETRY_REQUIRED' as const, reason: 'LEASE_EXPIRED' as const };
      if (await write(failed, current!.etag)) return { status: failed.status, reason: failed.reason };
      continue;
    }
    const next = { ...identity, status: 'RUNNING' as const, lease: {
      id: (dependencies.newLeaseId ?? randomUUID)(), expiresAtMs: now() + LEASE_MS,
    } };
    if (await write(next, current?.etag ?? null)) { owned = next; break; }
  }
  if (!owned) throw new Error('Video selection cache contention while claiming work.');
  const checkpoint = async (next: Exclude<PoolCacheRecord, { status: 'RUNNING' }>): Promise<CachedVideoSelectionResult> => {
    const current = await read();
    if (current?.value.status !== 'RUNNING' || current.value.lease.id !== owned!.lease.id
      || !await write(next, current.etag)) throw new Error('Video selection lease is no longer current.');
    return next.status === 'COMPLETE' ? { status: next.status, selection: next.selection } : { status: next.status, reason: next.reason };
  };
  if (Math.min(dependencies.deadlineAtMs, owned.lease.expiresAtMs) - now() < VIDEO_SELECTION_TIMEOUT_MS + 65_000) {
    return checkpoint({ ...identity, status: 'RETRY_REQUIRED', reason: 'INSUFFICIENT_TIME' });
  }
  let selection: VideoConceptSelection;
  try { selection = await selectVideoFramesForConceptPool(pool, brief, { model, request: dependencies.request }); }
  catch { return checkpoint({ ...identity, status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' }); }
  // Post-provider checkpoint failures propagate; never automatically repeat paid work.
  return checkpoint({ ...identity, status: 'COMPLETE', selection });
};

const visualSelectionCacheContext = (
  bindings: readonly VideoHumanSelectionPoolBinding[],
  concept: string,
  reuseContext: VideoFrameReuseContext,
  dependencies: VideoSelectionCacheDependencies,
) => {
  const brief = concept.trim(); const model = dependencies.model.trim();
  if (!brief || brief.length > 2_000 || !model || !Number.isSafeInteger(dependencies.deadlineAtMs)) {
    throw new Error('Video selection cache input is invalid.');
  }
  const { pool: canonical, imageCount } = canonicalizeVideoHumanSelectionPool(bindings);
  const reuse = canonicalizeVideoFrameReuseContext(reuseContext);
  const libraries: VisualPoolIdentityEntry[] = canonical.map(({ library, librarySha256, representativeImages }) => ({
    libraryId: library.id, sourceVideoMediaId: library.sourceVideoMediaId,
    sourceVideoContentHash: library.sourceVideoContentHash, librarySha256,
    frames: representativeImages.map(({ bytes: _bytes, ...identity }) => identity),
  }));
  const storage = dependencies.storage ?? getVideoIntelligenceStorage(); const now = dependencies.now ?? Date.now;
  const identity = { version: 3 as const, policy: HUMAN_FRAME_SELECTION_POLICY, libraries, reuseContext: reuse, model, concept: brief };
  const digest = createHash('sha256').update(JSON.stringify([3, HUMAN_FRAME_SELECTION_POLICY, libraries, reuse, brief, model])).digest('hex');
  const key = `selections/sha256/${digest}.json`;
  const read = async () => {
    const stored = await storage.read(key); if (!stored) return null;
    if (stored.bytes.length > MAX_VISUAL_RECORD_BYTES) throw new Error('Visual video selection cache exceeds its size limit.');
    const value = JSON.parse(stored.bytes.toString('utf8')) as VisualPoolCacheRecord;
    if (!value || value.version !== 3 || value.policy !== HUMAN_FRAME_SELECTION_POLICY || value.model !== model
      || value.concept !== brief || JSON.stringify(value.libraries) !== JSON.stringify(libraries)
      || JSON.stringify(value.reuseContext) !== JSON.stringify(reuse)) {
      throw new Error('Visual video selection cache identity is invalid.');
    }
    if (value.status === 'COMPLETE') value.outcome = parseVideoHumanFrameSelectionOutcome(
      { assessments: value.outcome.assessments }, canonical, brief, reuse,
    );
    else if (value.status === 'RUNNING') {
      if (!value.lease || typeof value.lease.id !== 'string' || !value.lease.id
        || !Number.isSafeInteger(value.lease.expiresAtMs)) throw new Error('Video selection cache lease is invalid.');
    } else if (value.status !== 'RETRY_REQUIRED' || !['LEASE_EXPIRED', 'PROVIDER_FAILED', 'INSUFFICIENT_TIME'].includes(value.reason)) {
      throw new Error('Video selection cache state is invalid.');
    }
    return { value, etag: stored.etag };
  };
  const write = (value: VisualPoolCacheRecord, etag: string | null) => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_VISUAL_RECORD_BYTES) throw new Error('Visual video selection cache exceeds its size limit.');
    return storage.write(key, bytes, etag);
  };
  return { brief, model, canonical, imageCount, reuse, identity, read, write, now };
};

export type VideoHumanSelectionPreflight = { status: 'READY' }
  | { status: 'COMPLETE'; outcome: VideoHumanFrameSelectionOutcome };

/** Read-only outgoing-work admission. Completed historical decisions remain usable under later sizing rules. */
export const preflightVideoHumanFrameFromPoolWithCache = async (
  bindings: readonly VideoHumanSelectionPoolBinding[],
  concept: string,
  reuseContext: VideoFrameReuseContext,
  dependencies: VideoSelectionCacheDependencies,
): Promise<VideoHumanSelectionPreflight> => {
  const { imageCount, read, model } = visualSelectionCacheContext(bindings, concept, reuseContext, dependencies);
  const current = await read();
  if (current?.value.status === 'COMPLETE') { emitProviderReuse('video-human-selection', model); return { status: 'COMPLETE', outcome: current.value.outcome }; }
  requireVisualSelectionOutputBudget(imageCount);
  return { status: 'READY' };
};

/** Versioned visual policy cache. Every admitted representative image and same-portfolio reuse count is identity-bound. */
export const selectVideoHumanFrameFromPoolWithCache = async (
  bindings: readonly VideoHumanSelectionPoolBinding[],
  concept: string,
  reuseContext: VideoFrameReuseContext,
  dependencies: VideoSelectionCacheDependencies,
): Promise<CachedVideoHumanSelectionResult> => {
  const { brief, model, canonical, imageCount, reuse, identity, read, write, now } =
    visualSelectionCacheContext(bindings, concept, reuseContext, dependencies);
  let owned: Extract<VisualPoolCacheRecord, { status: 'RUNNING' }> | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await read(); const value = current?.value;
    if (value?.status === 'COMPLETE') { emitProviderReuse('video-human-selection', model); return { status: 'COMPLETE', outcome: value.outcome }; }
    if (value?.status === 'RUNNING' && value.lease.expiresAtMs > now()) return { status: 'BUSY' };
    if (value?.status === 'RETRY_REQUIRED' && !dependencies.retry) return { status: value.status, reason: value.reason };
    if (value?.status === 'RUNNING' && !dependencies.retry) {
      const failed = { ...identity, status: 'RETRY_REQUIRED' as const, reason: 'LEASE_EXPIRED' as const };
      if (await write(failed, current!.etag)) return { status: failed.status, reason: failed.reason };
      continue;
    }
    // Admit only outgoing work. Historical complete results remain readable even if a later policy tightens sizing.
    requireVisualSelectionOutputBudget(imageCount);
    const next = { ...identity, status: 'RUNNING' as const, lease: {
      id: (dependencies.newLeaseId ?? randomUUID)(), expiresAtMs: now() + LEASE_MS,
    } };
    if (await write(next, current?.etag ?? null)) { owned = next; break; }
  }
  if (!owned) throw new Error('Video selection cache contention while claiming work.');
  const checkpoint = async (next: Exclude<VisualPoolCacheRecord, { status: 'RUNNING' }>): Promise<CachedVideoHumanSelectionResult> => {
    const current = await read();
    if (current?.value.status !== 'RUNNING' || current.value.lease.id !== owned!.lease.id
      || !await write(next, current.etag)) throw new Error('Video selection lease is no longer current.');
    return next.status === 'COMPLETE' ? { status: next.status, outcome: next.outcome } : { status: next.status, reason: next.reason };
  };
  if (Math.min(dependencies.deadlineAtMs, owned.lease.expiresAtMs) - now() < VIDEO_SELECTION_TIMEOUT_MS + 65_000) {
    return checkpoint({ ...identity, status: 'RETRY_REQUIRED', reason: 'INSUFFICIENT_TIME' });
  }
  let outcome: VideoHumanFrameSelectionOutcome;
  try { outcome = await selectVideoHumanFrameFromPool(canonical, brief, reuse, { model, request: dependencies.request }); }
  catch { return checkpoint({ ...identity, status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' }); }
  return checkpoint({ ...identity, status: 'COMPLETE', outcome });
};
