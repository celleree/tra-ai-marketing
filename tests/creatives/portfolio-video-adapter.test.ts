import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, getEffectiveIntervalFps } from '@/lib/video/candidate-policy';
import { analyzeFrameTechnicalQuality } from '@/lib/video/frame-technical-analysis';
import { createVideoFrameThumbnailFromBytes } from '@/lib/video/frame-thumbnail';
import { createVideoIntelligenceAnalyzerFingerprint, type VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import { videoIntelligenceJobKey } from '@/lib/video/intelligence-job';
import { checkpointVideoIntelligenceJob, claimVideoIntelligenceJob, readVideoIntelligenceJob } from '@/lib/video/intelligence-job-store';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const mediaId = `media_${'a'.repeat(32)}`;
const identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash: sha('source'),
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model') };
const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
const candidate = { candidateIndex: 0, timestampMs: 0, sourceRole: 'TRA_VIDEO' as const,
  sourceVideoMediaId: mediaId, sourceVideoFileName: `${mediaId}.mp4`, sourceVideoContentHash: identity.sourceVideoContentHash,
  mimeType: 'image/jpeg' as const, width: 2, height: 2, byteLength: jpeg.length, frameSha256: sha(jpeg),
  extractionReasons: ['INTERVAL'] as const, providerEligible: false as const, technical: await analyzeFrameTechnicalQuality(jpeg) };
const manifest: VideoIntelligencePreparationManifest = {
  version: 1, artifactType: 'VIDEO_INTELLIGENCE_PREPARATION', providerEligible: false,
  sourceVideoMediaId: mediaId, sourceVideoFileName: candidate.sourceVideoFileName,
  sourceVideoContentHash: identity.sourceVideoContentHash, sourceVideoByteLength: 6, durationMs: 2_000,
  effectiveIntervalFps: getEffectiveIntervalFps(2_000, DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY),
  analyzerFingerprint: identity.analyzerFingerprint, candidates: [candidate],
  groups: [{ representativeIndex: 0, candidateIndexes: [0] }],
  representativeBundle: { key: `preparations/bundles/sha256/${sha(jpeg)}.bin`, sha256: sha(jpeg), byteLength: jpeg.length,
    entries: [{ candidateIndex: 0, offset: 0, byteLength: jpeg.length }] },
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const preparation = { manifestKey: `preparations/manifests/sha256/${sha(manifestBytes)}.json`,
  manifestSha256: sha(manifestBytes), durationMs: manifest.durationMs, representativeCandidateIndexes: [0] };
const thumbnail = await createVideoFrameThumbnailFromBytes(candidate, jpeg);
const observation = { version: 1 as const, model: 'vision-model', providerEligible: false as const,
  evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const, sourceVideoMediaId: mediaId,
  sourceVideoContentHash: identity.sourceVideoContentHash, candidateIndex: 0, timestampMs: 0, frameSha256: candidate.frameSha256,
  observation: { sceneType: 'OTHER' as const, summary: 'Colored fixture.', composition: 'Full frame.', visibleText: [], topics: ['other' as const], uncertainties: [] } };


import { stepPortfolioVideoDependency } from '@/lib/creatives/portfolio-video-adapter';
import { newCreativePortfolio, claimCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { MemoryPortfolioStorage, portfolioRequest } from '../fixtures/creative-portfolio';
import type { PortfolioVideoDependency } from '@/lib/creatives/portfolio-video-dependency';
import { reserveOperatorQuota } from '@/lib/quotas/operator-quota';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const setup = async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL_ENV', 'development'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'vision-model');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live provider'); }));
  const storage = new MemoryPortfolioStorage(), clock = { value: 1000 };
  const now = () => clock.value;
  const request = { ...portfolioRequest(), sourceAssets: [{ mediaId, role: 'TRA_VIDEO' as const }] };
  const parent = claimCreativePortfolio({ ...newCreativePortfolio(request, now()), videoPreparationVersion: 1 }, now(), 'owner').job;
  await storage.write('creative-portfolios/v1/' + parent.id + '.json', Buffer.from(JSON.stringify(parent)), null);
  await storage.write(manifest.representativeBundle.key, jpeg, null);
  await storage.write(preparation.manifestKey, manifestBytes, null);
  const owner = {
    operatorId: 'operator', onProviderOperationStart: vi.fn(),
    assertLease: vi.fn(async () => {
      const job = await readCreativePortfolio(parent.id, storage);
      if (job?.lease?.id !== 'owner' || job.lease.expiresAtMs <= now()) throw new Error('Parent lease lost');
    }),
    checkpoint: vi.fn(async (dependency: PortfolioVideoDependency) => {
      await updateCreativePortfolio(parent.id, job => {
        if (job.planning.phase !== 'INITIAL_PLAN' || job.lease?.id !== 'owner') throw new Error('Parent lease lost');
        job.planning.preparation.videoDependencies = [dependency]; return job;
      }, storage);
    }),
  };
  const deps = { storage, now, deadlineAtMs: 2_000_000,
    hydrateSource: vi.fn(async () => ({ role: 'TRA_VIDEO' as const,
      media: { id: mediaId, fileName: mediaId + '.mp4', mimeType: 'video/mp4' as const, mediaType: 'VIDEO' as const, size: 6, url: '/video.mp4' },
      stored: { fileName: mediaId + '.mp4', mimeType: 'video/mp4' as const, mediaType: 'VIDEO' as const, buffer: Buffer.from('source') } })),
    preparation: vi.fn(async (id: typeof identity, lease: string) => checkpointVideoIntelligenceJob(id, lease,
      job => ({ ...job, phase: 'TRANSCRIBING', preparation, lease: null }), { storage, now })),
    transcription: vi.fn(async (id: typeof identity, lease: string) => checkpointVideoIntelligenceJob(id, lease,
      job => ({ ...job, phase: 'OBSERVING', lease: null, transcript: { version: 1, model: 'whisper-1',
        sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash, language: 'en', segments: [] } }), { storage, now })),
    observation: vi.fn(async (id: typeof identity, lease: string) => checkpointVideoIntelligenceJob(id, lease,
      job => ({ ...job, phase: 'OBSERVING', lease: null, representatives: [{ candidateIndex: 0, frameSha256: candidate.frameSha256, thumbnail, observation }] }), { storage, now })),
  };
  const saved = async () => {
    const job = await readCreativePortfolio(parent.id, storage);
    return job?.planning.phase === 'INITIAL_PLAN' ? job.planning.preparation.videoDependencies?.[0] : undefined;
  };
  const advance = async () => stepPortfolioVideoDependency({ mediaId, dependency: await saved(), action: 'ADVANCE', ...owner }, deps);
  return { storage, clock, deps, owner, saved, advance };
};

it('discovers/saves first, advances one child unit, reloads and reuses real finalized artifacts', async () => {
  const s = await setup();
  expect((await s.advance()).status).toBeNull(); expect(s.deps.preparation).not.toHaveBeenCalled();
  expect((await s.advance()).status?.phase).toBe('TRANSCRIBING');
  expect((await s.advance()).status?.phase).toBe('OBSERVING');
  expect((await s.advance()).status?.phase).toBe('OBSERVING');
  expect((await s.advance()).status?.phase).toBe('COMPLETE'); // real finalization and library loader
  expect(s.deps.transcription).toHaveBeenCalledTimes(1); expect(s.deps.observation).toHaveBeenCalledTimes(1);
  const completed = (await s.saved())!;
  expect((await stepPortfolioVideoDependency({ mediaId, action: 'ADVANCE', ...s.owner }, s.deps)).dependency).toEqual(completed);
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'changed-model');
  s.deps.hydrateSource.mockRejectedValue(new Error('Must not refresh completed dependency'));
  expect((await s.advance()).dependency).toEqual(completed);
  expect((await stepPortfolioVideoDependency({ mediaId, dependency: completed, action: 'STATUS' }, s.deps)).dependency).toEqual(completed);
  s.storage.data.delete(completed.completed!.artifact.key);
  await expect(s.advance()).rejects.toThrow('missing or corrupt');
  expect(s.deps.transcription).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});

it('status is read-only; busy leases, changed identities, quota denial and lost ownership cannot start work', async () => {
  const s = await setup(), before = JSON.stringify([...s.storage.data]);
  await stepPortfolioVideoDependency({ mediaId, action: 'STATUS' }, s.deps);
  expect(JSON.stringify([...s.storage.data])).toBe(before);
  await s.advance();
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'changed');
  await expect(s.advance()).rejects.toThrow('identity changed');
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'vision-model');
  s.deps.hydrateSource.mockResolvedValueOnce({ ...(await s.deps.hydrateSource()), stored: { ...(await s.deps.hydrateSource()).stored, buffer: Buffer.from('changed') } });
  await expect(s.advance()).rejects.toThrow('source changed');
  s.owner.assertLease.mockRejectedValueOnce(new Error('Parent lease lost'));
  await expect(s.advance()).rejects.toThrow('lease lost');
  const originalDeadline = s.deps.deadlineAtMs; s.deps.deadlineAtMs = s.clock.value;
  await expect(s.advance()).rejects.toThrow('Insufficient time'); s.deps.deadlineAtMs = originalDeadline;
  await reserveOperatorQuota({ operatorId: 'operator', group: 'VIDEO_PREPARATION', units: 12 }, s.deps);
  await expect(s.advance()).rejects.toThrow('quota');
  expect(s.deps.preparation).not.toHaveBeenCalled();
});

it('requires explicit retry after expired paid work and guards the consumed authorization against child races', async () => {
  const s = await setup(); await s.advance(); await s.advance();
  const claim = await claimVideoIntelligenceJob(identity, s.deps);
  if (claim.status !== 'WORK') throw new Error();
  const busyBytes = JSON.stringify([...s.storage.data]);
  expect((await s.advance()).status?.busy).toBe(true); expect(JSON.stringify([...s.storage.data])).toBe(busyBytes);
  s.clock.value = claim.job.lease!.expiresAtMs;
  const snapshot = JSON.stringify([...s.storage.data]);
  await stepPortfolioVideoDependency({ mediaId, dependency: await s.saved(), action: 'STATUS' }, s.deps);
  expect(JSON.stringify([...s.storage.data])).toBe(snapshot);
  expect((await s.advance()).status?.phase).toBe('RETRY_REQUIRED');
  await s.advance(); expect(s.deps.transcription).not.toHaveBeenCalled();
  const consume = vi.fn(async () => {
    // Concurrent writer changes the child revision after authorization was consumed.
    const stored = await s.storage.read(videoIntelligenceJobKey(identity));
    await s.storage.write(videoIntelligenceJobKey(identity), stored!.bytes, stored!.etag);
  });
  await expect(stepPortfolioVideoDependency({ mediaId, dependency: await s.saved(), action: 'RETRY',
    ...s.owner, consumeRetryAuthorization: consume }, s.deps)).rejects.toThrow('Retry state changed');
  expect(consume).toHaveBeenCalledTimes(1); expect(s.deps.transcription).not.toHaveBeenCalled();
  consume.mockRejectedValueOnce(new Error('Authorization already consumed'));
  await expect(stepPortfolioVideoDependency({ mediaId, dependency: await s.saved(), action: 'RETRY',
    ...s.owner, consumeRetryAuthorization: consume }, s.deps)).rejects.toThrow('already consumed');
  expect((await stepPortfolioVideoDependency({ mediaId, dependency: await s.saved(), action: 'RETRY',
    ...s.owner, consumeRetryAuthorization: async expected => { expect(expected.retry?.phase).toBe('TRANSCRIBING'); } }, s.deps)).status?.phase).toBe('OBSERVING');
  expect(s.deps.transcription).toHaveBeenCalledTimes(1);
});

it('does not replay successful child work after a parent checkpoint failure', async () => {
  const s = await setup(); await s.advance(); await s.advance();
  s.owner.checkpoint.mockRejectedValueOnce(new Error('Lost parent save'));
  await expect(s.advance()).rejects.toThrow('Lost parent save');
  expect(s.deps.transcription).toHaveBeenCalledTimes(1);
  expect((await s.advance()).status?.phase).toBe('OBSERVING');
  expect(s.deps.transcription).toHaveBeenCalledTimes(1); expect(s.deps.observation).toHaveBeenCalledTimes(1);
});

it('holds uncertain provider completion until expiry classification and explicit Retry', async () => {
  const s = await setup(); await s.advance(); await s.advance();
  s.deps.transcription.mockRejectedValueOnce(new Error('Uncertain provider response'));
  await expect(s.advance()).rejects.toThrow('Uncertain provider response');
  expect((await s.advance()).status?.busy).toBe(true);
  expect(s.deps.transcription).toHaveBeenCalledTimes(1);
  const child = await readVideoIntelligenceJob(identity, s.deps);
  s.clock.value = child!.job.lease!.expiresAtMs;
  expect((await s.advance()).status?.phase).toBe('RETRY_REQUIRED');
  await s.advance(); expect(s.deps.transcription).toHaveBeenCalledTimes(1);
});

it('recovers child completion after lost parent save without repeating analysis or finalization', async () => {
  const s = await setup();
  for (let i = 0; i < 4; i++) await s.advance();
  s.owner.checkpoint.mockRejectedValueOnce(new Error('Lost completion save'));
  await expect(s.advance()).rejects.toThrow('Lost completion save');
  expect((await s.saved())?.completed).toBeUndefined();
  expect((await s.advance()).dependency.completed).toBeDefined();
  expect(s.deps.transcription).toHaveBeenCalledTimes(1); expect(s.deps.observation).toHaveBeenCalledTimes(1);
});
