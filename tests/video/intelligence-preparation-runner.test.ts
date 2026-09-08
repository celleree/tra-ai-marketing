import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import type { PersistedVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-persistence';
import { runVideoIntelligencePreparationJob } from '@/lib/video/intelligence-preparation-runner';
import { claimVideoIntelligenceJob, readVideoIntelligenceJob, startVideoIntelligenceJob, VideoIntelligenceJobLeaseLostError } from '@/lib/video/intelligence-job-store';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('source-mp4-bytes');
const mediaId = `media_${'a'.repeat(32)}`;
const identity = {
  sourceVideoMediaId: mediaId,
  sourceVideoContentHash: hash(bytes),
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(
    DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
    'vision-model'
  ),
};
const source = (): HydratedTraVideoSource => ({
  role: 'TRA_VIDEO',
  media: { id: mediaId, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: bytes.length, url: '/media/source.mp4' },
  stored: { fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', buffer: Buffer.from(bytes) },
});

class MemoryStorage implements VideoIntelligenceStorage {
  value: { bytes: Buffer; etag: string } | null = null;
  version = 0;
  async read() { return this.value && { bytes: Buffer.from(this.value.bytes), etag: this.value.etag }; }
  async write(_key: string, next: Buffer, expected: string | null) {
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
const persisted = (indexes = [3, 479]): PersistedVideoIntelligencePreparation => ({
  manifestKey: `preparations/manifests/sha256/${hash('manifest')}.json`,
  manifestSha256: hash('manifest'),
  manifest: {
    sourceVideoMediaId: mediaId,
    sourceVideoContentHash: identity.sourceVideoContentHash,
    analyzerFingerprint: structuredClone(identity.analyzerFingerprint),
    durationMs: 2_000,
    representativeBundle: { entries: indexes.map((candidateIndex) => ({ candidateIndex })) },
  } as PersistedVideoIntelligencePreparation['manifest'],
});

describe('video intelligence preparation runner', () => {
  it('persists with frozen settings and checkpoints through the actual job store', async () => {
    const deps = setup();
    const start = await startVideoIntelligenceJob(identity, deps);
    const allIndexes = Array.from({ length: 480 }, (_, index) => index);
    const prepare = vi.fn(async (_source, options, prepareDeps) => {
      expect(options).toEqual({ visionModel: 'vision-model', policy: DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY });
      expect(prepareDeps.storage).toBe(deps.storage);
      return persisted(allIndexes);
    });

    await expect(runVideoIntelligencePreparationJob(identity, start.job.lease!.id, source(), { storage: deps.storage, now: deps.now, prepare }))
      .resolves.toMatchObject({ phase: 'TRANSCRIBING', lease: null, preparation: { durationMs: 2_000, representativeCandidateIndexes: allIndexes } });
    expect((await readVideoIntelligenceJob(identity, deps))?.job).toMatchObject({ phase: 'TRANSCRIBING', preparation: { manifestKey: persisted().manifestKey, manifestSha256: persisted().manifestSha256 } });
  });

  it('rejects stale ownership before preparation and never overwrites a replacement lease', async () => {
    const deps = setup();
    const start = await startVideoIntelligenceJob(identity, deps);
    const prepare = vi.fn(async () => persisted());
    await expect(runVideoIntelligencePreparationJob(identity, 'other-lease', source(), { storage: deps.storage, now: deps.now, prepare }))
      .rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
    expect(prepare).not.toHaveBeenCalled();

    const latePrepare = vi.fn(async () => {
      const stored = (await readVideoIntelligenceJob(identity, deps))!;
      const replacement = { ...stored.job, lease: { ...stored.job.lease!, id: 'replacement' } };
      deps.storage.value = { bytes: Buffer.from(JSON.stringify(replacement)), etag: 'replacement' };
      return persisted();
    });
    await expect(runVideoIntelligencePreparationJob(identity, start.job.lease!.id, source(), { storage: deps.storage, now: deps.now, prepare: latePrepare }))
      .rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
    expect((await readVideoIntelligenceJob(identity, deps))?.job.lease?.id).toBe('replacement');
  });

  it('rejects mismatched hydrated input or preparation output without advancing work', async () => {
    const deps = setup();
    const start = await startVideoIntelligenceJob(identity, deps);
    const prepare = vi.fn(async () => persisted());
    const wrongSource = source();
    wrongSource.stored.buffer = Buffer.from('different');
    await expect(runVideoIntelligencePreparationJob(identity, start.job.lease!.id, wrongSource, { storage: deps.storage, now: deps.now, prepare }))
      .rejects.toThrow('matching hydrated TRA_VIDEO MP4');
    expect(prepare).not.toHaveBeenCalled();

    const wrongResult = persisted();
    wrongResult.manifest.sourceVideoContentHash = hash('different');
    await expect(runVideoIntelligencePreparationJob(identity, start.job.lease!.id, source(), { storage: deps.storage, now: deps.now, prepare: vi.fn(async () => wrongResult) }))
      .rejects.toThrow('does not match the current job');
    expect((await readVideoIntelligenceJob(identity, deps))?.job).toMatchObject({ phase: 'PREPARING', lease: { id: start.job.lease!.id } });
  });

  it('leaves preparation failures reclaimable and accepts completion while its late lease remains current', async () => {
    const deps = setup();
    const start = await startVideoIntelligenceJob(identity, deps);
    const failure = new Error('storage unavailable');
    await expect(runVideoIntelligencePreparationJob(identity, start.job.lease!.id, source(), { storage: deps.storage, now: deps.now, prepare: vi.fn(async () => { throw failure; }) })).rejects.toBe(failure);
    expect((await readVideoIntelligenceJob(identity, deps))?.job.phase).toBe('PREPARING');
    deps.clock.value = start.job.lease!.expiresAtMs;
    const claimed = await claimVideoIntelligenceJob(identity, deps);
    if (claimed.status !== 'WORK') throw new Error('Expected reclaimed preparation lease.');
    expect(claimed.job.phase).toBe('PREPARING');
    deps.clock.value = claimed.job.lease!.expiresAtMs;
    await expect(runVideoIntelligencePreparationJob(identity, claimed.leaseId, source(), { storage: deps.storage, now: deps.now, prepare: vi.fn(async () => persisted()) }))
      .resolves.toMatchObject({ phase: 'TRANSCRIBING' });
  });
});
