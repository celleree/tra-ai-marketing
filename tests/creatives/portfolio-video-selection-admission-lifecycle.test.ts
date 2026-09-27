import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { claimCreativePortfolio, finishPortfolioPlan, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { reserveOperatorQuota } from '@/lib/quotas/operator-quota';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

const mocks = vi.hoisted(() => ({ restore: vi.fn(), render: vi.fn(), inventory: vi.fn(), list: vi.fn(), loadContext: vi.fn() }));
vi.mock('@/lib/creatives/portfolio-snapshot', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-snapshot')>(), restoreCreativePortfolio: mocks.restore,
}));
vi.mock('@/lib/creatives/render-planned', () => ({ renderPlannedCreative: mocks.render }));
vi.mock('@/lib/creatives/generation-sources', async original => ({
  ...await original<typeof import('@/lib/creatives/generation-sources')>(), hydratePlanningSourceInventory: mocks.inventory,
}));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: mocks.list }));
vi.mock('@/lib/video/selection-context', async original => ({
  ...await original<typeof import('@/lib/video/selection-context')>(), loadSavedVideoSelectionContext: mocks.loadContext,
}));

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const jpeg = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#765432' } }).jpeg().toBuffer();
const mediaId = `media_${'a'.repeat(32)}`, sourceBytes = Buffer.from('admission-video'), sourceHash = sha(sourceBytes);
const source = { role: 'TRA_VIDEO', media: { id: mediaId, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO',
  size: sourceBytes.length, url: '/source.mp4' }, stored: { fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO',
  buffer: sourceBytes } } as HydratedTraVideoSource;
const artifactSha = sha('library-artifact'), preparationSha = sha('preparation-artifact');
const identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
  analyzerFingerprint: { visionModel: 'vision-model', sha256: sha('fingerprint') } };
const artifact = { key: `libraries/sha256/${artifactSha}.json`, sha256: artifactSha, byteLength: 100 };
const pool = (count: number) => {
  const candidates = Array.from({ length: count }, (_, candidateIndex) => ({ candidateIndex,
    timestampMs: 1_000 + candidateIndex, frameSha256: sha(jpeg), width: 96, height: 96,
    extractionReasons: ['INTERVAL'], technical: { qualityScore: count - candidateIndex } }));
  const representatives = candidates.map((candidate) => ({ id: videoCandidateFrameId(sourceHash, candidate.timestampMs, candidate.frameSha256),
    candidateIndex: candidate.candidateIndex, candidateIndexes: [candidate.candidateIndex],
    timestampMs: candidate.timestampMs, frameSha256: candidate.frameSha256, qualityScore: count - candidate.candidateIndex,
    observation: { sceneType: 'PERSON', summary: 'Visible person', composition: 'Portrait', visibleText: [], topics: ['person'], uncertainties: [] } }));
  const library = { version: 1, id: `video-library:${sha(`library-${count}`)}`, sourceVideoMediaId: mediaId,
    sourceVideoContentHash: sourceHash, representativeFrames: representatives, candidates };
  const representativeImages = representatives.map((frame) => ({ frameId: frame.id, candidateIndex: frame.candidateIndex,
    timestampMs: frame.timestampMs, frameSha256: frame.frameSha256, width: 96, height: 96, bytes: jpeg }));
  const context = { library, librarySha256: artifactSha, preparationSha256: preparationSha,
    manifest: { sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash }, representativeImages };
  return { library, context };
};
const sourceAnalysis = (library: ReturnType<typeof pool>['library']) => ({ version: 1, entries: [{
  source: { role: 'TRA_VIDEO', mediaId, sha256: sourceHash },
  analyzer: { kind: 'VIDEO_INTELLIGENCE', model: 'vision-model', schemaVersion: 1, contextSha256: null },
  evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result: { kind: 'VIDEO_INTELLIGENCE', intelligence: {
    identity, jobId: `video-intelligence:${sha('job')}`, artifact, library: { id: library.id, version: library.version },
  } },
}] });
const ready = async (storage: MemoryPortfolioStorage, videoPool: ReturnType<typeof pool>) => {
  const request = { ...portfolioRequest(), sourceAssets: [{ role: 'TRA_VIDEO' as const, mediaId }] };
  const created = await createCreativePortfolio(request, storage);
  const claimed = await updateCreativePortfolio(created.id, current => claimCreativePortfolio(current, Date.now(), 'plan').job, storage);
  const snapshot = portfolioSnapshot(claimed) as any;
  await updateCreativePortfolio(created.id, current => finishPortfolioPlan(current, 'plan', snapshot), storage);
  return updateCreativePortfolio(created.id, current => { const next = structuredClone(current);
    next.slots[1].status = 'SAVED'; next.updatedAtMs = Date.now(); return next; }, storage);
};
const restoredContext = (snapshot: any, videoPool: ReturnType<typeof pool>) => {
  const restored = structuredClone(snapshot);
  restored.batchPlan.creatives[0].strategy.execution.subjectSource = 'approved-tra-human';
  restored.batchPlan.creatives[0].strategy.conceptDetails = { mainMessage: 'Understand the next step', proposition: 'Get a clear path',
    visualMechanism: 'Person reviewing a notice', subject: 'Person', environment: 'Home office' };
  return { ...restored, sourceAnalysis: sourceAnalysis(videoPool.library), storage: {}, providerImageSource: null,
    videoFrameSet: { source, frames: [{}] }, brandLogo: null, reserveLogoArea: false };
};
const assessment = (eyes: 'OPEN_OR_NOT_VISIBLE' | 'CLOSED_OR_BLINKING' = 'OPEN_OR_NOT_VISIBLE') => ({
  humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes, blur: 'CLEAR', occlusion: 'NONE_OR_MINOR',
  expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE', observableReason: 'Observable portrait geometry.',
  sourceOverlay: { status: 'CLEAN', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 },
});
const providerResult = (value: unknown) => Response.json({ status: 'completed', output: [{ content: [
  { type: 'output_text', text: JSON.stringify(value) },
] }] });
const quotaUsed = (storage: MemoryPortfolioStorage) => [...storage.data.entries()]
  .filter(([key]) => key.endsWith('/VIDEO_SELECTION.json'))
  .map(([, value]) => JSON.parse(value.bytes.toString('utf8')).usedUnits as number);
const selectionKeys = (storage: MemoryPortfolioStorage) => [...storage.data.keys()].filter(key => key.startsWith('selections/candidates/'));
const configure = (videoPool: ReturnType<typeof pool>) => {
  mocks.loadContext.mockResolvedValue(videoPool.context);
  mocks.restore.mockImplementation(async (snapshot) => restoredContext(snapshot, videoPool));
};

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('OPENAI_API_KEY', 'offline-test-only'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'frozen-model');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected live provider request'); }));
  mocks.list.mockResolvedValue([]); mocks.inventory.mockResolvedValue([{ source }]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('portfolio candidate-selection admission lifecycle', () => {
  it('admits one cold candidate, persists exact selection, then reuses its assessment without another charge', async () => {
    const storage = new MemoryPortfolioStorage(), videoPool = pool(2); configure(videoPool);
    const request = vi.fn<typeof fetch>().mockResolvedValue(providerResult(assessment())); vi.stubGlobal('fetch', request);
    const first = await ready(storage, videoPool);
    const selected = await advanceCreativePortfolio(first.id, 'operator', 'http://localhost', storage);
    expect(selected.job.slots[0]).toMatchObject({ status: 'PENDING', videoSelection: {
      selectionPolicy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, selection: { version: 3,
        candidateBindings: [{ candidateIndex: 0, representativeFrameId: videoPool.library.representativeFrames[0].id }] } } });
    expect(selected.job.lease).toBeNull(); expect(quotaUsed(storage)).toEqual([1]);
    expect(selectionKeys(storage)).toHaveLength(1); expect(request).toHaveBeenCalledOnce(); expect(mocks.render).not.toHaveBeenCalled();
    const second = await ready(storage, videoPool);
    const reused = await advanceCreativePortfolio(second.id, 'operator', 'http://localhost', storage);
    expect(reused.job.slots[0].videoSelection?.selection).toEqual(selected.job.slots[0].videoSelection?.selection);
    expect(quotaUsed(storage)).toEqual([1]); expect(request).toHaveBeenCalledOnce();
    expect((await readCreativePortfolio(second.id, storage))?.slots[0].videoSelection?.selection).toEqual(reused.job.slots[0].videoSelection?.selection);
  });

  it('checkpoints one unsuitable candidate per call and blocks after all groups fail', async () => {
    const storage = new MemoryPortfolioStorage(), videoPool = pool(2); configure(videoPool);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => providerResult(assessment('CLOSED_OR_BLINKING'))); vi.stubGlobal('fetch', request);
    const job = await ready(storage, videoPool);
    expect((await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage)).status).toBe(202);
    expect((await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage)).status).toBe(202);
    const blocked = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(blocked).toMatchObject({ status: 409, job: { lease: null, slots: [{ status: 'BLOCKED' }, { status: 'SAVED' }] } });
    expect(quotaUsed(storage)).toEqual([2]); expect(selectionKeys(storage)).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2); expect(mocks.render).not.toHaveBeenCalled();
    await expect(updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage)).rejects.toThrow('does not require a retry');
  });

  it('keeps quota denial ahead of candidate cache leases and provider work', async () => {
    const storage = new MemoryPortfolioStorage(), videoPool = pool(2); configure(videoPool);
    await reserveOperatorQuota({ operatorId: 'operator', group: 'VIDEO_SELECTION', units: 24 }, { storage });
    const job = await ready(storage, videoPool);
    const denied = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(denied).toMatchObject({ status: 429, job: { lease: null, slots: [{ status: 'PENDING' }, { status: 'SAVED' }] } });
    expect(quotaUsed(storage)).toEqual([24]); expect(selectionKeys(storage)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
  });

  it('requires explicit retry after an uncertain candidate request and retains the frozen model', async () => {
    const storage = new MemoryPortfolioStorage(), videoPool = pool(2); configure(videoPool);
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue(providerResult(assessment())); vi.stubGlobal('fetch', request);
    const job = await ready(storage, videoPool);
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0]).toMatchObject({ status: 'RETRY_REQUIRED', videoSelection: { selectionModel: 'frozen-model' } });
    vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'changed-model');
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
    const selected = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(selected.job.slots[0]).toMatchObject({ status: 'PENDING', videoSelection: {
      selectionModel: 'frozen-model', selection: { version: 3 } } });
    expect(request).toHaveBeenCalledTimes(2); expect(quotaUsed(storage)).toEqual([2]);
  });
});
