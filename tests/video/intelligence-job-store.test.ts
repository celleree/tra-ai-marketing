import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import { parseVideoIntelligenceJob, videoIntelligenceJobKey, type VideoIntelligenceJob } from '@/lib/video/intelligence-job';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { checkpointVideoIntelligenceJob, claimVideoIntelligenceJob, readVideoIntelligenceJob, retryVideoIntelligenceJob, startVideoIntelligenceJob, VideoIntelligenceJobLeaseLostError } from '@/lib/video/intelligence-job-store';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const mediaId = `media_${'a'.repeat(32)}`;
const identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash: hash('video'), analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model') };
const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
const preparation = (indexes = [1, 2, 3]) => ({ manifestKey: `preparations/manifests/sha256/${hash('manifest')}.json`, manifestSha256: hash('manifest'), durationMs: 2_000, representativeCandidateIndexes: indexes });
class MemoryStorage implements VideoIntelligenceStorage {
  value: { bytes: Buffer; etag: string } | null = null; conflicts = 0; replacement: Buffer | null = null; version = 0;
  async read() { return this.value && { bytes: Buffer.from(this.value.bytes), etag: this.value.etag }; }
  async write(_key: string, bytes: Buffer, expected: string | null) {
    if (this.replacement) { this.value = { bytes: this.replacement, etag: `opaque-${++this.version}` }; this.replacement = null; return false; }
    if (this.conflicts-- > 0 || (expected === null ? this.value !== null : this.value?.etag !== expected)) return false;
    this.value = { bytes: Buffer.from(bytes), etag: `opaque-${++this.version}` }; return true;
  }
}
const setup = (storage = new MemoryStorage(), now = { value: 1_000 }) => ({ storage, now: () => now.value, newLeaseId: (() => { let n = 0; return () => `lease-${++n}`; })(), clock: now });
const requireWork = (claim: Awaited<ReturnType<typeof claimVideoIntelligenceJob>>) => {
  if (claim.status !== 'WORK') throw new Error('Expected work.');
  return claim;
};
const representative = (candidateIndex: number) => ({ candidateIndex, frameSha256: hash(`frame-${candidateIndex}`), thumbnail: {
    sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash, candidateIndex, timestampMs: 100,
    frameSha256: hash(`frame-${candidateIndex}`), thumbnailDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
  }, observation: { version: 1 as const, model: 'vision-model', providerEligible: false as const, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const,
    sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash, candidateIndex, timestampMs: 100, frameSha256: hash(`frame-${candidateIndex}`),
    observation: { sceneType: 'OTHER' as const, summary: 'Frame.', composition: 'Frame.', visibleText: [], topics: ['other' as const], uncertainties: [] } } });
const complete = (job: VideoIntelligenceJob, candidateIndex: number) => ({
  ...job, representatives: [...job.representatives, representative(candidateIndex)], lease: null,
});
const toObserving = async (deps: ReturnType<typeof setup>, indexes: number[]) => {
  const start = await startVideoIntelligenceJob(identity, deps);
  await checkpointVideoIntelligenceJob(identity, start.job.lease!.id, (job) => ({ ...job, phase: 'TRANSCRIBING', preparation: preparation(indexes), lease: null }), deps);
  const transcribing = await claimVideoIntelligenceJob(identity, deps);
  if (transcribing.status !== 'WORK') throw new Error('Expected transcription work.');
  return checkpointVideoIntelligenceJob(identity, transcribing.leaseId, (job) => ({ ...job, phase: 'OBSERVING', transcript: { version: 1, model: 'whisper-1', sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash, language: 'en', segments: [] }, lease: null }), deps);
};

describe('video intelligence job store', () => {
  it('creates once and returns the current job to simultaneous starters', async () => {
    const deps = setup(); const [left, right] = await Promise.all([startVideoIntelligenceJob(identity, deps), startVideoIntelligenceJob(identity, deps)]);
    expect([left.created, right.created].filter(Boolean)).toHaveLength(1); expect((await readVideoIntelligenceJob(identity, deps))?.etag).toBe('opaque-1');
  });
  it('claims with opaque-ETag CAS and reports busy work', async () => {
    const deps = setup(); const started = await startVideoIntelligenceJob(identity, deps); expect((await claimVideoIntelligenceJob(identity, deps)).status).toBe('BUSY');
    deps.clock.value = started.job.lease!.expiresAtMs; deps.storage.conflicts = 1;
    const claimed = await claimVideoIntelligenceJob(identity, deps); expect(claimed).toMatchObject({ status: 'WORK', leaseId: 'lease-3' });
  });
  it('grants concurrent claim ownership to exactly one worker', async () => {
    const deps = setup(); await toObserving(deps, [1]);
    const claims = await Promise.all([claimVideoIntelligenceJob(identity, deps), claimVideoIntelligenceJob(identity, deps)]);
    expect(claims.map(({ status }) => status).sort()).toEqual(['BUSY', 'WORK']);
  });
  it('requires explicit retry after expired paid work and preserves partial results', async () => {
    const deps = setup(); const started = await startVideoIntelligenceJob(identity, deps); const prepared = await checkpointVideoIntelligenceJob(identity, started.job.lease!.id, (job) => ({ ...job, phase: 'TRANSCRIBING', preparation: preparation(), lease: null }), deps);
    const transcribing = await claimVideoIntelligenceJob(identity, deps); deps.clock.value = transcribing.job.lease!.expiresAtMs;
    expect((await claimVideoIntelligenceJob(identity, deps)).status).toBe('RETRY_REQUIRED');
    const retried = await retryVideoIntelligenceJob(identity, deps); expect(retried).toMatchObject({ status: 'WORK', job: { phase: 'TRANSCRIBING', preparation: prepared.preparation } });
  });
  it('grants concurrent explicit retry ownership to exactly one worker', async () => {
    const deps = setup(); const start = await startVideoIntelligenceJob(identity, deps); await checkpointVideoIntelligenceJob(identity, start.job.lease!.id, (job) => ({ ...job, phase: 'TRANSCRIBING', preparation: preparation(), lease: null }), deps);
    const work = requireWork(await claimVideoIntelligenceJob(identity, deps)); deps.clock.value = work.job.lease!.expiresAtMs; await claimVideoIntelligenceJob(identity, deps);
    const retries = await Promise.all([retryVideoIntelligenceJob(identity, deps), retryVideoIntelligenceJob(identity, deps)]);
    expect(retries.map(({ status }) => status).sort()).toEqual(['BUSY', 'WORK']);
  });
  it('reclaims non-paid work and atomically finalizes when no observation work remains', async () => {
    const deps = setup(); const start = await startVideoIntelligenceJob(identity, deps); deps.clock.value = start.job.lease!.expiresAtMs;
    expect(await claimVideoIntelligenceJob(identity, deps)).toMatchObject({ status: 'WORK', job: { phase: 'PREPARING' } });
    const observed = await toObserving(deps, [1]);
    const observing = requireWork(await claimVideoIntelligenceJob(identity, deps)); const done = await checkpointVideoIntelligenceJob(identity, observing.leaseId, (job) => complete(job, 1), deps);
    const finalizing = requireWork(await claimVideoIntelligenceJob(identity, deps)); expect(finalizing).toMatchObject({ job: { phase: 'FINALIZING', representatives: done.representatives } });
    expect(await checkpointVideoIntelligenceJob(identity, finalizing.leaseId, (job) => ({ ...job, phase: 'COMPLETE', lease: null, result: { key: `libraries/sha256/${hash('library')}.json`, sha256: hash('library'), byteLength: 1 } }), deps)).toMatchObject({ phase: 'COMPLETE' });
    expect(await claimVideoIntelligenceJob(identity, deps)).toMatchObject({ status: 'COMPLETE' });
    expect(observed.phase).toBe('OBSERVING');
  });
  it('limits missing observation work to pairs and rejects stale lease completion', async () => {
    const deps = setup(); const prepared = await toObserving(deps, [1, 2, 479]);
    const first = requireWork(await claimVideoIntelligenceJob(identity, deps)); expect(first.job.lease?.candidateIndexes).toEqual([1, 2]);
    const thumbnail = representative(1).thumbnail;
    const partial = await checkpointVideoIntelligenceJob(identity, first.leaseId, (job) => ({ ...job, representatives: [{ candidateIndex: 1, frameSha256: hash('frame-1'), thumbnail }] }), deps);
    await expect(checkpointVideoIntelligenceJob(identity, first.leaseId, (job) => ({ ...job, representatives: [] }), deps)).rejects.toThrow('erase saved work');
    await expect(checkpointVideoIntelligenceJob(identity, first.leaseId, (job) => ({ ...job, lease: { ...job.lease!, expiresAtMs: job.lease!.expiresAtMs + 1 } }), deps)).rejects.toThrow('may not change a lease');
    await checkpointVideoIntelligenceJob(identity, partial.lease!.id, (job) => ({ ...job, representatives: [{ ...job.representatives[0], observation: representative(1).observation }], lease: null }), deps);
    const second = requireWork(await claimVideoIntelligenceJob(identity, deps)); expect(second.job.lease?.candidateIndexes).toEqual([2, 479]); deps.clock.value = second.job.lease!.expiresAtMs;
    expect(await claimVideoIntelligenceJob(identity, deps)).toMatchObject({ status: 'RETRY_REQUIRED', job: { retry: { candidateIndexes: [2, 479] } } });
    expect(await retryVideoIntelligenceJob(identity, deps)).toMatchObject({ job: { representatives: [{ candidateIndex: 1 }], lease: { candidateIndexes: [2, 479] } } });
    await expect(checkpointVideoIntelligenceJob(identity, first.leaseId, (job) => job, deps)).rejects.toThrow('no longer current'); expect(prepared.representatives).toEqual([]);
  });
  it('accepts a late checkpoint only while its lease remains current and reads terminal status', async () => {
    const deps = setup(); const start = await startVideoIntelligenceJob(identity, deps); deps.clock.value = start.job.lease!.expiresAtMs;
    const late = await checkpointVideoIntelligenceJob(identity, start.job.lease!.id, (job) => ({ ...job, phase: 'FAILED', lease: null, failure: { phase: 'PREPARING', message: 'bad input' } }), deps);
    expect(late.phase).toBe('FAILED'); expect(await claimVideoIntelligenceJob(identity, deps)).toMatchObject({ status: 'FAILED' });
    expect(() => parseVideoIntelligenceJob(deps.storage.value!.bytes, identity)).not.toThrow(); expect(videoIntelligenceJobKey(identity)).toContain('jobs/sha256');
  });
  it('rejects a checkpoint whose CAS loses to a replacement lease', async () => {
    const deps = setup(); const start = await startVideoIntelligenceJob(identity, deps); deps.storage.replacement = Buffer.from(JSON.stringify({ ...start.job, lease: { ...start.job.lease!, id: 'replacement' } }));
    await expect(checkpointVideoIntelligenceJob(identity, start.job.lease!.id, (job) => ({ ...job, phase: 'FAILED', lease: null, failure: { phase: 'PREPARING', message: 'bad input' } }), deps)).rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
  });
});
