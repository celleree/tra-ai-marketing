import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { checkpointVideoIntelligenceJob, claimVideoIntelligenceJob, startVideoIntelligenceJob } from '@/lib/video/intelligence-job-store';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import {
  executeVideoIntelligenceStep,
  readVideoIntelligenceSource,
  resolveVideoIntelligenceJobLocator,
  VideoIntelligenceServiceError,
} from '@/lib/video/intelligence-service';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const mediaId = `media_${'a'.repeat(32)}`;
const bytes = Buffer.from('trusted-video-bytes');
const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
const source = (): HydratedTraVideoSource => ({
  role: 'TRA_VIDEO', media: { id: mediaId, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: bytes.length, url: '/source.mp4' },
  stored: { fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', buffer: Buffer.from(bytes) },
});

class MemoryStorage implements VideoIntelligenceStorage {
  values = new Map<string, { bytes: Buffer; etag: string }>();
  version = 0;
  async read(key: string) {
    const value = this.values.get(key);
    return value ? { bytes: Buffer.from(value.bytes), etag: value.etag } : null;
  }
  async write(key: string, next: Buffer, expected: string | null) {
    const current = this.values.get(key);
    if (expected === null ? current !== undefined : current?.etag !== expected) return false;
    this.values.set(key, { bytes: Buffer.from(next), etag: `etag-${++this.version}` });
    return true;
  }
}

const setup = () => {
  const storage = new MemoryStorage();
  const clock = { value: 1_000 };
  const hydrateSource = vi.fn(async () => source());
  return { storage, clock, hydrateSource, deps: { storage, now: () => clock.value, deadlineAtMs: 99_000, hydrateSource } };
};
const identity = () => ({ sourceVideoMediaId: mediaId, sourceVideoContentHash: hash(bytes),
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra') });
const locator = () => ({ version: 1 as const, sourceVideoMediaId: mediaId, sourceVideoContentHash: hash(bytes), analyzerFingerprintSha256: identity().analyzerFingerprint.sha256 });
const preparation = () => ({ manifestKey: `preparations/manifests/sha256/${hash('manifest')}.json`, manifestSha256: hash('manifest'), durationMs: 1_000, representativeCandidateIndexes: [0] });
const requireWork = (claim: Awaited<ReturnType<typeof claimVideoIntelligenceJob>>) => {
  if (claim.status !== 'WORK') throw new Error('Expected work.');
  return claim;
};
const toObserving = async (state: ReturnType<typeof setup>) => {
  const started = await startVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now });
  await checkpointVideoIntelligenceJob(identity(), started.job.lease!.id, (job) => ({ ...job, phase: 'TRANSCRIBING', preparation: preparation(), lease: null }), { storage: state.storage, now: state.deps.now });
  const transcription = requireWork(await claimVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now }));
  await checkpointVideoIntelligenceJob(identity(), transcription.leaseId, (job) => ({ ...job, phase: 'OBSERVING', lease: null, transcript: { version: 1, model: 'whisper-1', sourceVideoMediaId: mediaId, sourceVideoContentHash: hash(bytes), language: 'en', segments: [] } }), { storage: state.storage, now: state.deps.now });
};
const representative = () => ({ candidateIndex: 0, frameSha256: hash(jpeg), thumbnail: { sourceVideoMediaId: mediaId, sourceVideoContentHash: hash(bytes), candidateIndex: 0, timestampMs: 0, frameSha256: hash(jpeg), thumbnailDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` }, observation: { version: 1 as const, model: identity().analyzerFingerprint.visionModel, providerEligible: false as const, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const, sourceVideoMediaId: mediaId, sourceVideoContentHash: hash(bytes), candidateIndex: 0, timestampMs: 0, frameSha256: hash(jpeg), observation: { sceneType: 'OTHER' as const, summary: 'Frame.', composition: 'Frame.', visibleText: [], topics: ['other' as const], uncertainties: [] } } });

describe('video intelligence service', () => {
  it('hydrates once for reopen, binds the current source hash, and never starts work', async () => {
    const state = setup();
    const result = await readVideoIntelligenceSource(mediaId, state.deps);
    expect(result).toMatchObject({ source: { id: mediaId, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: bytes.length, url: '/source.mp4' }, locator: locator(), status: null });
    expect(result.source).not.toHaveProperty('stored');
    expect(JSON.stringify(result.source)).not.toContain('trusted-video-bytes');
    expect(state.hydrateSource).toHaveBeenCalledTimes(1);
  });

  it('runs preparation only for the creator and returns existing jobs without claiming them', async () => {
    const state = setup();
    const prepare = vi.fn(async (_identity, _leaseId, _source, deps) => {
      expect(deps.storage).toBe(state.storage);
      return (await startVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now })).job;
    });
    const first = await executeVideoIntelligenceStep({ action: 'START', mediaId }, { ...state.deps, preparation: prepare as never });
    expect(prepare).toHaveBeenCalledTimes(1);
    const second = await executeVideoIntelligenceStep({ action: 'START', mediaId }, { ...state.deps, preparation: prepare as never });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ jobId: first.jobId, phase: 'PREPARING', busy: true });
  });

  it('reports a live lease as busy and excludes leases, artifacts, and transcript data', async () => {
    const state = setup();
    await startVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now });
    const result = await executeVideoIntelligenceStep({ action: 'STATUS', locator: locator() }, state.deps);
    expect(result).toMatchObject({ phase: 'PREPARING', busy: true, completedRepresentatives: 0, totalRepresentatives: null });
    expect(JSON.stringify(result)).not.toMatch(/lease|artifact|transcript|representatives/);
  });

  it('routes one claimed transcription unit with the request-entry deadline', async () => {
    const state = setup();
    const started = await startVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now });
    await checkpointVideoIntelligenceJob(identity(), started.job.lease!.id, (job) => ({ ...job, phase: 'TRANSCRIBING', preparation: preparation(), lease: null }), { storage: state.storage, now: state.deps.now });
    const transcribe = vi.fn(async (_identity, _leaseId, _source, deps) => {
      expect(deps.deadlineAtMs).toBe(99_000);
      return (await startVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now })).job;
    });
    await executeVideoIntelligenceStep({ action: 'ADVANCE', locator: locator() }, { ...state.deps, transcription: transcribe as never });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(state.hydrateSource).toHaveBeenCalledTimes(1);
  });

  it('requires explicit retry for expired paid work', async () => {
    const state = setup(); const started = await startVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now });
    await checkpointVideoIntelligenceJob(identity(), started.job.lease!.id, (job) => ({ ...job, phase: 'TRANSCRIBING', preparation: preparation(), lease: null }), { storage: state.storage, now: state.deps.now });
    const work = requireWork(await claimVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now })); state.clock.value = work.job.lease!.expiresAtMs;
    await claimVideoIntelligenceJob(identity(), { storage: state.storage, now: state.deps.now });
    const transcribe = vi.fn(async () => work.job);
    expect(await executeVideoIntelligenceStep({ action: 'ADVANCE', locator: locator() }, { ...state.deps, transcription: transcribe as never })).toMatchObject({ phase: 'RETRY_REQUIRED' });
    expect(transcribe).not.toHaveBeenCalled();
    await executeVideoIntelligenceStep({ action: 'RETRY', locator: locator() }, { ...state.deps, transcription: transcribe as never });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('dispatches observation and finalization without rehydrating the MP4', async () => {
    const observationState = setup(); await toObserving(observationState);
    const observe = vi.fn(async (_identity, _leaseId, deps) => { expect(deps.deadlineAtMs).toBe(99_000); return (await claimVideoIntelligenceJob(identity(), { storage: observationState.storage, now: observationState.deps.now })).job; });
    await executeVideoIntelligenceStep({ action: 'ADVANCE', locator: locator() }, { ...observationState.deps, observation: observe as never });
    expect(observe).toHaveBeenCalledTimes(1); expect(observationState.hydrateSource).not.toHaveBeenCalled();
    const finalState = setup(); await toObserving(finalState); const observationWork = requireWork(await claimVideoIntelligenceJob(identity(), { storage: finalState.storage, now: finalState.deps.now }));
    await checkpointVideoIntelligenceJob(identity(), observationWork.leaseId, (job) => ({ ...job, representatives: [representative()], lease: null }), { storage: finalState.storage, now: finalState.deps.now });
    const finalize = vi.fn(async () => (await claimVideoIntelligenceJob(identity(), { storage: finalState.storage, now: finalState.deps.now })).job);
    await executeVideoIntelligenceStep({ action: 'ADVANCE', locator: locator() }, { ...finalState.deps, finalization: finalize as never });
    expect(finalize).toHaveBeenCalledTimes(1); expect(finalState.hydrateSource).not.toHaveBeenCalled();
  });

  it('keeps retry explicit and rejects invalid or stale locators with typed errors', async () => {
    const state = setup();
    await expect(executeVideoIntelligenceStep({ action: 'STATUS', locator: { ...locator(), analyzerFingerprintSha256: '0'.repeat(64) } }, state.deps))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<VideoIntelligenceServiceError>);
    expect(() => resolveVideoIntelligenceJobLocator({ version: 1, sourceVideoMediaId: 'bad', sourceVideoContentHash: hash(bytes), analyzerFingerprintSha256: hash('x') }))
      .toThrow(VideoIntelligenceServiceError);
    await expect(readVideoIntelligenceSource(42 as never, state.deps)).rejects.toMatchObject({ status: 400 });
    await expect(executeVideoIntelligenceStep({ action: 'START', mediaId: [] as never }, state.deps)).rejects.toMatchObject({ status: 400 });
    await expect(executeVideoIntelligenceStep({ action: 'ADVANCE', locator: locator() }, state.deps))
      .rejects.toMatchObject({ status: 404 } satisfies Partial<VideoIntelligenceServiceError>);
  });
});
