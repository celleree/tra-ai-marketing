import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, getEffectiveIntervalFps } from '@/lib/video/candidate-policy';
import type { VideoIntelligenceJob, VideoIntelligenceRepresentativeProgress } from '@/lib/video/intelligence-job';
import { videoIntelligenceJobKey } from '@/lib/video/intelligence-job';
import {
  checkpointVideoIntelligenceJob, claimVideoIntelligenceJob, retryVideoIntelligenceJob,
  startVideoIntelligenceJob, VideoIntelligenceJobLeaseLostError,
} from '@/lib/video/intelligence-job-store';
import { runVideoIntelligenceObservationJob } from '@/lib/video/intelligence-observation-runner';
import { createVideoIntelligenceAnalyzerFingerprint, type VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { VIDEO_VISION_TIMEOUT_MS } from '@/lib/video/visual-observation';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
const mediaId = `media_${'a'.repeat(32)}`;
const identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash: hash('video'),
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'frozen-vision-model') };
const observationPayload = { sceneType: 'OTHER', summary: 'Frame.', composition: 'Centered.', visibleText: [], topics: ['other'], uncertainties: [] };
const response = () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(observationPayload) }] }] });

class MemoryStorage implements VideoIntelligenceStorage {
  values = new Map<string, { bytes: Buffer; etag: string }>(); version = 0; jobWrites = 0; failJobWrite: Error | null = null;
  async read(key: string) { const value = this.values.get(key); return value ? { bytes: Buffer.from(value.bytes), etag: value.etag } : null; }
  async write(key: string, bytes: Buffer, expected: string | null) {
    const current = this.values.get(key);
    if (expected === null ? current : current?.etag !== expected) return false;
    if (key === videoIntelligenceJobKey(identity)) { this.jobWrites += 1; if (this.failJobWrite) throw this.failJobWrite; }
    this.values.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++this.version}` }); return true;
  }
  put(key: string, bytes: Buffer) { this.values.set(key, { bytes: Buffer.from(bytes), etag: `artifact-${++this.version}` }); }
  replaceLease(id: string) {
    const key = videoIntelligenceJobKey(identity); const stored = this.values.get(key)!;
    const job = JSON.parse(stored.bytes.toString()) as VideoIntelligenceJob;
    this.values.set(key, { bytes: Buffer.from(JSON.stringify({ ...job, lease: { ...job.lease!, id } })), etag: `replacement-${++this.version}` });
  }
}

const fixture = (count: number) => {
  const durationMs = Math.max(1_000, count * 100); const frameSha256 = hash(jpeg);
  const candidates = Array.from({ length: count }, (_, candidateIndex) => ({
    candidateIndex, timestampMs: candidateIndex * 100, sourceRole: 'TRA_VIDEO' as const, sourceVideoMediaId: mediaId,
    sourceVideoFileName: 'source.mp4', sourceVideoContentHash: identity.sourceVideoContentHash, mimeType: 'image/jpeg' as const,
    width: 2, height: 2, byteLength: jpeg.length, frameSha256,
    extractionReasons: (candidateIndex < Math.min(360, count) ? ['INTERVAL'] : ['SCENE_CHANGE']) as ['INTERVAL'] | ['SCENE_CHANGE'],
    providerEligible: false as const, technical: { version: 1 as const, analysisWidth: 2, analysisHeight: 2,
      differenceHash: '0'.repeat(16), meanRgb: [1, 1, 1] as [number, number, number], meanLuminance: 1,
      luminanceDeviation: 1, laplacianVariance: 1, darkFraction: 0, lightFraction: 0, qualityScore: 1 },
  }));
  const bundle = Buffer.concat(Array.from({ length: count }, () => jpeg));
  const manifest: VideoIntelligencePreparationManifest = {
    version: 1, artifactType: 'VIDEO_INTELLIGENCE_PREPARATION', providerEligible: false, sourceVideoMediaId: mediaId,
    sourceVideoFileName: 'source.mp4', sourceVideoContentHash: identity.sourceVideoContentHash, sourceVideoByteLength: 5,
    durationMs, effectiveIntervalFps: getEffectiveIntervalFps(durationMs, DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY),
    analyzerFingerprint: structuredClone(identity.analyzerFingerprint), candidates,
    groups: candidates.map(({ candidateIndex }) => ({ representativeIndex: candidateIndex, candidateIndexes: [candidateIndex] })),
    representativeBundle: { key: `preparations/bundles/sha256/${hash(bundle)}.bin`, sha256: hash(bundle), byteLength: bundle.length,
      entries: candidates.map(({ candidateIndex }) => ({ candidateIndex, offset: candidateIndex * jpeg.length, byteLength: jpeg.length })) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { manifest, manifestBytes, manifestKey: `preparations/manifests/sha256/${hash(manifestBytes)}.json`, bundle };
};

const progress = (candidateIndex: number, timestampMs = candidateIndex * 100, observed = true): VideoIntelligenceRepresentativeProgress => ({
  candidateIndex, frameSha256: hash(jpeg), thumbnail: { sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash,
    candidateIndex, timestampMs, frameSha256: hash(jpeg), thumbnailDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
  ...(observed ? { observation: { version: 1, model: identity.analyzerFingerprint.visionModel, providerEligible: false,
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash,
    candidateIndex, timestampMs, frameSha256: hash(jpeg), observation: observationPayload as never } } : {}),
});

const setup = async (count = 2, saved: VideoIntelligenceRepresentativeProgress[] = [], durationDelta = 0, jobIndexes?: number[]) => {
  const storage = new MemoryStorage(); const clock = { value: 1_000 }; const prepared = fixture(count);
  storage.put(prepared.manifestKey, prepared.manifestBytes); storage.put(prepared.manifest.representativeBundle.key, prepared.bundle);
  const deps = { storage, now: () => clock.value, newLeaseId: (() => { let index = 0; return () => `lease-${++index}`; })() };
  const started = await startVideoIntelligenceJob(identity, deps);
  await checkpointVideoIntelligenceJob(identity, started.job.lease!.id, (job) => ({ ...job, phase: 'TRANSCRIBING', lease: null,
    preparation: { manifestKey: prepared.manifestKey, manifestSha256: hash(prepared.manifestBytes),
      durationMs: prepared.manifest.durationMs + durationDelta,
      representativeCandidateIndexes: jobIndexes ?? prepared.manifest.representativeBundle.entries.map((entry) => entry.candidateIndex) } }), deps);
  const transcription = await claimVideoIntelligenceJob(identity, deps); if (transcription.status !== 'WORK') throw new Error('Expected transcription work.');
  await checkpointVideoIntelligenceJob(identity, transcription.leaseId, (job) => ({ ...job, phase: 'OBSERVING', lease: null,
    transcript: { version: 1, model: 'whisper-1', sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash,
      language: 'en', segments: [] }, representatives: saved }), deps);
  const work = await claimVideoIntelligenceJob(identity, deps); if (work.status !== 'WORK') throw new Error('Expected observation work.');
  storage.jobWrites = 0;
  return { storage, clock, deps, work, deadlineAtMs: clock.value + VIDEO_VISION_TIMEOUT_MS + 65_000 };
};

afterEach(() => vi.unstubAllEnvs());

describe('video intelligence observation runner', () => {
  it('runs a pair with the frozen model, checkpoints once, and lets the store claim finalization', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key'); const state = await setup(); const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const result = await runVideoIntelligenceObservationJob(identity, state.work.leaseId, { storage: state.storage, now: state.deps.now,
      deadlineAtMs: state.deadlineAtMs, request });
    expect(result).toMatchObject({ phase: 'OBSERVING', lease: null }); expect(result.representatives).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2); expect(state.storage.jobWrites).toBe(1);
    expect(request.mock.calls.map((call) => JSON.parse(call[1]!.body as string).model)).toEqual(['frozen-vision-model', 'frozen-vision-model']);
    expect(await claimVideoIntelligenceJob(identity, state.deps)).toMatchObject({ status: 'WORK', job: { phase: 'FINALIZING' } });
  });

  it('drains a failed pair, saves its partner, and retries only the missing observation', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key'); const state = await setup(); let call = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => ++call === 1 ? new Response('', { status: 429 }) : response());
    const failed = await runVideoIntelligenceObservationJob(identity, state.work.leaseId, { storage: state.storage, now: state.deps.now,
      deadlineAtMs: state.deadlineAtMs, request });
    expect(failed).toMatchObject({ phase: 'RETRY_REQUIRED', retry: { candidateIndexes: [0], reason: 'PAID_WORK_FAILED' } });
    expect(failed.representatives).toHaveLength(2); expect(failed.representatives[1].observation).toBeDefined();
    const retry = await retryVideoIntelligenceJob(identity, state.deps); if (retry.status !== 'WORK') throw new Error('Expected retry work.');
    await runVideoIntelligenceObservationJob(identity, retry.leaseId, { storage: state.storage, now: state.deps.now,
      deadlineAtMs: state.deadlineAtMs, request });
    expect(request).toHaveBeenCalledTimes(3); expect(await claimVideoIntelligenceJob(identity, state.deps)).toMatchObject({ job: { phase: 'FINALIZING' } });
  });

  it('rejects stale ownership and preparation or saved-progress mismatches before paid work', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key'); const request = vi.fn<typeof fetch>(); const stale = await setup();
    await expect(runVideoIntelligenceObservationJob(identity, 'other', { storage: stale.storage, now: stale.deps.now,
      deadlineAtMs: stale.deadlineAtMs, request })).rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
    const duration = await setup(2, [], 1);
    await expect(runVideoIntelligenceObservationJob(identity, duration.work.leaseId, { storage: duration.storage, now: duration.deps.now,
      deadlineAtMs: duration.deadlineAtMs, request })).rejects.toThrow('preparation does not match');
    const indexes = await setup(2, [], 0, [0]);
    await expect(runVideoIntelligenceObservationJob(identity, indexes.work.leaseId, { storage: indexes.storage, now: indexes.deps.now,
      deadlineAtMs: indexes.deadlineAtMs, request })).rejects.toThrow('preparation does not match');
    const timestamp = await setup(2, [progress(0, 1, false)]);
    await expect(runVideoIntelligenceObservationJob(identity, timestamp.work.leaseId, { storage: timestamp.storage, now: timestamp.deps.now,
      deadlineAtMs: timestamp.deadlineAtMs, request })).rejects.toThrow('does not match saved progress');
    const wrongHash = progress(0, 0, false); wrongHash.frameSha256 = '0'.repeat(64); wrongHash.thumbnail!.frameSha256 = wrongHash.frameSha256;
    const frame = await setup(2, [wrongHash]);
    await expect(runVideoIntelligenceObservationJob(identity, frame.work.leaseId, { storage: frame.storage, now: frame.deps.now,
      deadlineAtMs: frame.deadlineAtMs, request })).rejects.toThrow('does not match saved progress');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not start paid work without budget, but releases a lease whose observations are already complete', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key'); const request = vi.fn<typeof fetch>(); const short = await setup();
    const retried = await runVideoIntelligenceObservationJob(identity, short.work.leaseId, { storage: short.storage, now: short.deps.now,
      deadlineAtMs: short.deadlineAtMs - 1, request });
    expect(retried).toMatchObject({ phase: 'RETRY_REQUIRED', retry: { candidateIndexes: [0, 1], reason: 'PAID_WORK_FAILED',
      message: expect.stringContaining('requests not started') } });
    const complete = await setup(); await checkpointVideoIntelligenceJob(identity, complete.work.leaseId,
      (job) => ({ ...job, representatives: [progress(0), progress(1)] }), complete.deps);
    const released = await runVideoIntelligenceObservationJob(identity, complete.work.leaseId, { storage: complete.storage, now: complete.deps.now,
      deadlineAtMs: complete.clock.value, request });
    expect(released).toMatchObject({ phase: 'OBSERVING', lease: null }); expect(request).not.toHaveBeenCalled();
  });

  it('preserves all 480 representatives and resolves the leased tail pair', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key'); const saved = Array.from({ length: 478 }, (_, index) => progress(index));
    const state = await setup(480, saved); expect(state.work.job.lease?.candidateIndexes).toEqual([478, 479]);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const result = await runVideoIntelligenceObservationJob(identity, state.work.leaseId, { storage: state.storage, now: state.deps.now,
      deadlineAtMs: state.deadlineAtMs, request });
    expect(result.representatives).toHaveLength(480); expect(result.representatives.at(-1)?.candidateIndex).toBe(479);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('propagates storage and replacement-lease failures after draining paid requests without repeating them', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key'); const storageFailure = await setup(); const unavailable = new Error('storage unavailable');
    const firstRequest = vi.fn<typeof fetch>().mockImplementation(async () => { storageFailure.storage.failJobWrite = unavailable; return response(); });
    await expect(runVideoIntelligenceObservationJob(identity, storageFailure.work.leaseId, { storage: storageFailure.storage,
      now: storageFailure.deps.now, deadlineAtMs: storageFailure.deadlineAtMs, request: firstRequest })).rejects.toBe(unavailable);
    expect(firstRequest).toHaveBeenCalledTimes(2);
    const stale = await setup(); let replaced = false; const secondRequest = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (!replaced) { replaced = true; stale.storage.replaceLease('replacement'); } return response();
    });
    await expect(runVideoIntelligenceObservationJob(identity, stale.work.leaseId, { storage: stale.storage, now: stale.deps.now,
      deadlineAtMs: stale.deadlineAtMs, request: secondRequest })).rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
    expect(secondRequest).toHaveBeenCalledTimes(2);
  });
});
