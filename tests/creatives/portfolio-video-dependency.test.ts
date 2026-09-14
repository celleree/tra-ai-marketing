import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { parsePortfolioVideoDependencies, type PortfolioVideoDependency } from '@/lib/creatives/portfolio-video-dependency';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import { videoIntelligenceJobId } from '@/lib/video/intelligence-job';
import { newCreativePortfolio, claimCreativePortfolio, retryPortfolioWork, PORTFOLIO_LEASE_MS } from '@/lib/creatives/portfolio-job';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { MemoryPortfolioStorage, portfolioRequest } from '../fixtures/creative-portfolio';

const videoWork = vi.hoisted(() => vi.fn(() => { throw new Error('Unexpected video service call'); }));
vi.mock('@/lib/video/intelligence-service', () => ({ executeVideoIntelligenceStep: videoWork, readVideoIntelligenceSource: videoWork }));
const video = { mediaId: 'media_' + 'a'.repeat(32), role: 'TRA_VIDEO' as const };
const identity = { sourceVideoMediaId: video.mediaId, sourceVideoContentHash: 'b'.repeat(64),
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'recorded-model') };
const dependency: PortfolioVideoDependency = { version: 1, identity, jobId: videoIntelligenceJobId(identity) };
const completed = { artifact: { key: 'libraries/sha256/' + 'c'.repeat(64) + '.json', sha256: 'c'.repeat(64), byteLength: 100 },
  library: { version: 1 as const, id: 'video-library:' + createHash('sha256').update(video.mediaId + ':' + identity.sourceVideoContentHash).digest('hex') } };
const request = () => ({ ...portfolioRequest(), sourceAssets: [video] });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('round-trips compact existing identities independently of current analyzer settings', () => {
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'different-current-model');
  const value = [{ ...dependency, completed }];
  expect(parsePortfolioVideoDependencies(value, [video])).toEqual(value);
  expect(encode(value).length).toBeLessThan(4096);
  const parsed = parsePortfolioVideoDependencies(value, [video]);
  parsed[0].identity.sourceVideoContentHash = 'd'.repeat(64);
  expect(value[0].identity.sourceVideoContentHash).toBe(identity.sourceVideoContentHash);
});

it('rejects malformed/unsupported versions, identity mismatches and noncompact data', () => {
  const bad = [
    null, {}, { ...dependency, version: 2 }, { ...dependency, version: '1' }, { ...dependency, thumbnail: 'pixels' },
    { ...dependency, jobId: 'video-intelligence-job:' + 'd'.repeat(64) },
    { ...dependency, identity: { ...identity, sourceVideoContentHash: '../unsafe' } },
    { ...dependency, identity: { ...identity, sourceVideoMediaId: 'media_' + 'f'.repeat(32) } },
    { ...dependency, identity: { ...identity, analyzerFingerprint: { ...identity.analyzerFingerprint, sha256: 'e'.repeat(64) } } },
    { ...dependency, identity: { ...identity, analyzerFingerprint: { ...identity.analyzerFingerprint, pipelineVersion: 'future' } } },
    ...[{ artifact: { ...completed.artifact, key: '../other' } }, { artifact: { ...completed.artifact, byteLength: 32 * 1024 * 1024 + 1 } },
      { artifact: { ...completed.artifact, byteLength: 0 } }, { artifact: { ...completed.artifact, sha256: 'bad' } },
      { library: { ...completed.library, version: 2 } }, { library: { ...completed.library, id: 'video-library:' + 'f'.repeat(64) } },
      { library: { ...completed.library, transcript: 'x'.repeat(5000) } },
    ].map(change => ({ ...dependency, completed: { ...completed, ...change } })),
  ];
  for (const entry of bad) expect(() => parsePortfolioVideoDependencies([entry], [video])).toThrow();
  expect(() => parsePortfolioVideoDependencies([dependency, dependency], [video])).toThrow();
  expect(() => parsePortfolioVideoDependencies([dependency], [{ ...video, role: 'LAYOUT_REFERENCE' }])).toThrow();
  expect(() => parsePortfolioVideoDependencies(Array(41).fill(dependency), [video])).toThrow();
});

it('preserves immutable identity/completion, pending completion and explicit lease retry through storage', async () => {
  const storage = new MemoryPortfolioStorage(), job = { ...newCreativePortfolio(request(), 1000), videoPreparationVersion: 1 as const };
  if (job.planning.phase !== 'INITIAL_PLAN') throw new Error();
  job.planning.preparation.videoDependencies = [dependency];
  const key = 'creative-portfolios/v1/' + job.id + '.json';
  await storage.write(key, encode(job), null);
  const finish = await updateCreativePortfolio(job.id, current => {
    if (current.planning.phase === 'INITIAL_PLAN') current.planning.preparation.videoDependencies![0].completed = completed;
    return current;
  }, storage);
  expect(await readCreativePortfolio(job.id, storage)).toEqual(finish);
  const changedIdentity = { ...identity, sourceVideoContentHash: 'd'.repeat(64) };
  for (const replace of [[{ ...dependency, identity: changedIdentity, jobId: videoIntelligenceJobId(changedIdentity) }], [], [{ ...dependency, completed: { ...completed, artifact: { ...completed.artifact, byteLength: 101 } } }],
    [dependency], [{ ...dependency, jobId: 'changed', completed }]]) {
    await expect(updateCreativePortfolio(job.id, current => {
      if (current.planning.phase === 'INITIAL_PLAN') current.planning.preparation.videoDependencies = replace;
      return current;
    }, storage)).rejects.toThrow('immutable');
  }
  await expect(updateCreativePortfolio(job.id, current => ({ ...current, videoPreparationVersion: undefined }), storage)).rejects.toThrow('immutable');
  await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000, 'lease').job, storage);
  await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000 + PORTFOLIO_LEASE_MS).job, storage);
  const retried = await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null, 3000 + PORTFOLIO_LEASE_MS), storage);
  expect(retried.planning).toEqual(finish.planning);
});

it('keeps activation absent and reads/lease transitions free of video/provider work', async () => {
  const fetch = vi.fn(() => { throw new Error('Unexpected provider'); }); vi.stubGlobal('fetch', fetch);
  const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(request(), storage, 1000);
  expect(job).not.toHaveProperty('videoPreparationVersion');
  expect(await readCreativePortfolio(job.id, storage)).toEqual(job);
  await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000, 'lease').job, storage);
  expect([...storage.data.keys()]).toEqual(['creative-portfolios/v1/' + job.id + '.json']);
  expect(fetch).not.toHaveBeenCalled();
  expect(videoWork).not.toHaveBeenCalled();
  await expect(updateCreativePortfolio(job.id, current => ({ ...current, videoPreparationVersion: 1 }), storage)).rejects.toThrow('immutable');
});

it('enforces the saved-job size limit and requires a marker for dependencies', () => {
  const job = newCreativePortfolio(request());
  if (job.planning.phase !== 'INITIAL_PLAN') throw new Error();
  job.planning.preparation.videoDependencies = [dependency];
  expect(() => parseCreativePortfolioJob(encode(job), job.id)).toThrow('invalid');
  const enabled = { ...job, videoPreparationVersion: 1 };
  expect(parseCreativePortfolioJob(encode(enabled), job.id)).toEqual(enabled);
  const preparation = job.planning.preparation;
  const sourceAnalysis = { version: 1, entries: [{ source: { ...video, sha256: 'd'.repeat(64) },
    analyzer: { kind: 'REPRESENTATIVE_VIDEO_FRAMES', model: 'saved', schemaVersion: 1, contextSha256: 'e'.repeat(64) },
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' }] };
  expect(() => parseCreativePortfolioJob(encode({ ...enabled, planning: { phase: 'INITIAL_PLAN',
    preparation: { ...preparation, sourceAnalysis } } }), job.id)).toThrow('invalid');
  expect(() => parseCreativePortfolioJob(encode({ ...enabled, padding: 'x'.repeat(2 * 1024 * 1024) }), job.id)).toThrow('invalid');
  for (const version of [0, 2, '1', null]) {
    expect(() => parseCreativePortfolioJob(encode({ ...job, videoPreparationVersion: version }), job.id)).toThrow('Unsupported');
  }
});
