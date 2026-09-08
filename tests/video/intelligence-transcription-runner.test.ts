import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import { checkpointVideoIntelligenceJob, claimVideoIntelligenceJob, readVideoIntelligenceJob, startVideoIntelligenceJob, VideoIntelligenceJobLeaseLostError } from '@/lib/video/intelligence-job-store';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { runVideoIntelligenceTranscriptionJob } from '@/lib/video/intelligence-transcription-runner';
import { VIDEO_TRANSCRIPTION_TIMEOUT_MS } from '@/lib/video/transcript';
import { REAL_MULTI_FRAME_MP4 } from '@/tests/fixtures/media';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const mediaId = `media_${'a'.repeat(32)}`;
const identity = {
  sourceVideoMediaId: mediaId,
  sourceVideoContentHash: hash(REAL_MULTI_FRAME_MP4),
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model'),
};
const source = (): HydratedTraVideoSource => ({
  role: 'TRA_VIDEO',
  media: { id: mediaId, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: REAL_MULTI_FRAME_MP4.length, url: '/media/source.mp4' },
  stored: { fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', buffer: Buffer.from(REAL_MULTI_FRAME_MP4) },
});
const transcriptPayload = { language: 'en', segments: [{ start: 0, end: 1, text: 'Transcript.' }] };

class MemoryStorage implements VideoIntelligenceStorage {
  value: { bytes: Buffer; etag: string } | null = null;
  version = 0;
  failure: Error | null = null;
  async read() { return this.value && { bytes: Buffer.from(this.value.bytes), etag: this.value.etag }; }
  async write(_key: string, next: Buffer, expected: string | null) {
    if (this.failure) throw this.failure;
    if (expected === null ? this.value !== null : this.value?.etag !== expected) return false;
    this.value = { bytes: Buffer.from(next), etag: `etag-${++this.version}` };
    return true;
  }
}

const setup = () => {
  const storage = new MemoryStorage();
  const clock = { value: 1_000 };
  return { storage, clock, now: () => clock.value, newLeaseId: (() => { let index = 0; return () => `lease-${++index}`; })() };
};
const transcribingWork = async (deps: ReturnType<typeof setup>) => {
  const start = await startVideoIntelligenceJob(identity, deps);
  await checkpointVideoIntelligenceJob(identity, start.job.lease!.id, (job) => ({
    ...job, phase: 'TRANSCRIBING', lease: null,
    preparation: { manifestKey: `preparations/manifests/sha256/${hash('manifest')}.json`, manifestSha256: hash('manifest'), durationMs: 2_000, representativeCandidateIndexes: [1] },
  }), deps);
  const work = await claimVideoIntelligenceJob(identity, deps);
  if (work.status !== 'WORK') throw new Error('Expected transcription work.');
  return work;
};
const deadline = (deps: ReturnType<typeof setup>) => deps.clock.value + VIDEO_TRANSCRIPTION_TIMEOUT_MS + 65_000;

afterEach(() => vi.unstubAllEnvs());

describe('video intelligence transcription runner', () => {
  it('calls Whisper once through the real helper and checkpoints a source-bound transcript', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const deps = setup(); const work = await transcribingWork(deps);
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(transcriptPayload));
    await expect(runVideoIntelligenceTranscriptionJob(identity, work.leaseId, source(), { storage: deps.storage, now: deps.now, deadlineAtMs: deadline(deps), request }))
      .resolves.toMatchObject({ phase: 'OBSERVING', lease: null, transcript: { sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects stale ownership and a mismatched source before fetching', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const deps = setup(); const work = await transcribingWork(deps); const request = vi.fn<typeof fetch>();
    await expect(runVideoIntelligenceTranscriptionJob(identity, 'other-lease', source(), { storage: deps.storage, now: deps.now, deadlineAtMs: deadline(deps), request }))
      .rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
    const wrong = source(); wrong.stored.buffer = Buffer.from('different');
    await expect(runVideoIntelligenceTranscriptionJob(identity, work.leaseId, wrong, { storage: deps.storage, now: deps.now, deadlineAtMs: deadline(deps), request }))
      .rejects.toThrow('matching hydrated TRA_VIDEO MP4');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not start paid work when the server deadline or lease has expired', async () => {
    const deps = setup(); const work = await transcribingWork(deps); const request = vi.fn<typeof fetch>();
    await expect(runVideoIntelligenceTranscriptionJob(identity, work.leaseId, source(), { storage: deps.storage, now: deps.now, deadlineAtMs: Infinity, request }))
      .rejects.toThrow('safe server deadline timestamp');
    await expect(runVideoIntelligenceTranscriptionJob(identity, work.leaseId, source(), { storage: deps.storage, now: deps.now, deadlineAtMs: deadline(deps) - 1, request }))
      .resolves.toMatchObject({ phase: 'RETRY_REQUIRED', lease: null, retry: { reason: 'PAID_WORK_FAILED', message: expect.stringContaining('request not started') } });
    expect(request).not.toHaveBeenCalled();

    const expiredDeps = setup(); const expired = await transcribingWork(expiredDeps);
    expiredDeps.clock.value = expired.job.lease!.expiresAtMs;
    await expect(runVideoIntelligenceTranscriptionJob(identity, expired.leaseId, source(), { storage: expiredDeps.storage, now: expiredDeps.now, deadlineAtMs: deadline(expiredDeps), request }))
      .resolves.toMatchObject({ phase: 'RETRY_REQUIRED', retry: { reason: 'PAID_WORK_FAILED' } });
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves preparation after provider failure and does not overwrite a replacement lease', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const deps = setup(); const work = await transcribingWork(deps);
    const failed = await runVideoIntelligenceTranscriptionJob(identity, work.leaseId, source(), { storage: deps.storage, now: deps.now, deadlineAtMs: deadline(deps), request: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })) });
    expect(failed).toMatchObject({ phase: 'RETRY_REQUIRED', preparation: { durationMs: 2_000 }, retry: { reason: 'PAID_WORK_FAILED', message: expect.stringContaining('HTTP 429') } });

    const next = setup(); const active = await transcribingWork(next);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      const current = (await readVideoIntelligenceJob(identity, next))!;
      next.storage.value = { bytes: Buffer.from(JSON.stringify({ ...current.job, lease: { ...current.job.lease!, id: 'replacement' } })), etag: 'replacement' };
      return Response.json(transcriptPayload);
    });
    await expect(runVideoIntelligenceTranscriptionJob(identity, active.leaseId, source(), { storage: next.storage, now: next.now, deadlineAtMs: deadline(next), request }))
      .rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
    expect((await readVideoIntelligenceJob(identity, next))?.job.lease?.id).toBe('replacement');
  });

  it('propagates a checkpoint storage failure after a successful provider response', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const deps = setup(); const work = await transcribingWork(deps); const failure = new Error('storage unavailable');
    const request = vi.fn<typeof fetch>().mockImplementation(async () => { deps.storage.failure = failure; return Response.json(transcriptPayload); });
    await expect(runVideoIntelligenceTranscriptionJob(identity, work.leaseId, source(), { storage: deps.storage, now: deps.now, deadlineAtMs: deadline(deps), request }))
      .rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
