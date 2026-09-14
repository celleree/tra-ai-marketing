import { beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { claimCreativePortfolio, finishPortfolioPlan, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { portfolioSnapshot, MemoryPortfolioStorage, portfolioRequest } from '../fixtures/creative-portfolio';

const mocks = vi.hoisted(() => ({
  restore: vi.fn(), render: vi.fn(), select: vi.fn(), hydrate: vi.fn(), inventory: vi.fn(), list: vi.fn(), quota: vi.fn(),
}));
vi.mock('@/lib/creatives/portfolio-snapshot', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-snapshot')>(), restoreCreativePortfolio: mocks.restore,
}));
vi.mock('@/lib/creatives/render-planned', () => ({ renderPlannedCreative: mocks.render }));
vi.mock('@/lib/creatives/portfolio-video-selection', () => ({
  selectPortfolioVideoFrames: mocks.select, hydratePortfolioVideoFrameSelection: mocks.hydrate,
}));
vi.mock('@/lib/creatives/generation-sources', async original => ({
  ...await original<typeof import('@/lib/creatives/generation-sources')>(), hydratePlanningSourceInventory: mocks.inventory,
}));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: mocks.list }));
vi.mock('@/lib/quotas/operator-quota', async original => ({
  ...await original<typeof import('@/lib/quotas/operator-quota')>(), reserveOperatorQuota: mocks.quota,
}));

const mediaId = `media_${'a'.repeat(32)}`;
const sourceHash = 'b'.repeat(64);
const libraryId = `video-library:${'c'.repeat(64)}`;
const frameId = `video-frame:${'d'.repeat(64)}`;
const selection = { libraryId, sourceVideoContentHash: sourceHash, frameIds: [frameId] };
const provenance = [{ frameIndex: 0, libraryFrameId: frameId, candidateFrameSha256: 'e'.repeat(64),
  timestampMs: 1200, approvedPngSha256: 'f'.repeat(64) }];
const videoSource = { role: 'TRA_VIDEO', media: { id: mediaId, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO',
  size: 5, url: '/source.mp4' }, stored: { fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', buffer: Buffer.from('video') } };
const selectedFrames = { source: videoSource, sourceVideoContentHash: sourceHash, durationMs: 2000, reused: false,
  frames: [{ frameIndex: 0, timestampMs: 1200, mimeType: 'image/png', buffer: Buffer.from('png'), frameSha256: 'f'.repeat(64),
    byteLength: 3, sourceRole: 'TRA_VIDEO', sourceVideoMediaId: mediaId, sourceVideoFileName: 'source.mp4',
    sourceVideoContentHash: sourceHash, approvedHumanSource: true, cacheKey: null }], selectionProvenance: provenance };
const automaticRequest = (extra: Record<string, unknown> = {}) => ({ ...portfolioRequest(),
  sourceAssets: [{ role: 'TRA_VIDEO' as const, mediaId }], ...extra }) as any;

async function ready(storage: MemoryPortfolioStorage, request = automaticRequest()) {
  const created = await createCreativePortfolio(request, storage);
  return updateCreativePortfolio(created.id, current => {
    const token = 'planning-lease';
    const claimed = claimCreativePortfolio(current, Date.now() + 10, token).job;
    return finishPortfolioPlan(claimed, token, portfolioSnapshot(current), Date.now() + 20);
  }, storage);
}
const contextFor = (job: Awaited<ReturnType<typeof ready>>, overrides: Record<string, unknown> = {}) => ({
  ...job.snapshot!, sourceAnalysis: { version: 1, entries: [] }, storage: {}, brandLogo: null, reserveLogoArea: false,
  providerImageSource: undefined, videoFrameSet: { source: videoSource, frames: [{}] }, ...overrides,
}) as any;

beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'selector-model-a');
  mocks.list.mockResolvedValue([]); mocks.quota.mockResolvedValue({ allowed: true });
  mocks.inventory.mockResolvedValue([{ source: videoSource }]);
  mocks.select.mockResolvedValue({ status: 'COMPLETE', selection }); mocks.hydrate.mockResolvedValue(selectedFrames);
  mocks.render.mockImplementation(async (_concept, _context, options) => ({ id: options.creativeId }));
});

describe('durable portfolio B3 selection activation', () => {
  it('persists a cold automatic selection, releases the lease, and does not render in the same advance', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0]).toMatchObject({ status: 'PENDING', videoSelection: { version: 1,
      selectionModel: 'selector-model-a', selection } });
    expect(result.job.lease).toBeNull(); expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ finalConcept: expect.any(Object),
      cache: expect.objectContaining({ model: 'selector-model-a', retry: false }) }));
  });

  it('hydrates and renders only the persisted selection on the next advance without charging generation quota twice', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0].status).toBe('SAVED'); expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledWith(expect.objectContaining({ selection }));
    expect(mocks.render.mock.calls[0][1]).toMatchObject({ videoFrameSet: selectedFrames,
      generatedVideoFrameSelection: { libraryId, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash, frames: provenance } });
    expect(mocks.quota).toHaveBeenCalledTimes(1);
  });

  it('returns BUSY as transient 202 with the parent lease released and no Retry-required slot', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    mocks.select.mockResolvedValueOnce({ status: 'BUSY' });
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result).toMatchObject({ status: 202, retryAfterSeconds: 2, job: { lease: null } });
    expect(result.job.slots[0].status).toBe('PENDING'); expect(mocks.render).not.toHaveBeenCalled();
  });

  it('requires explicit Retry after uncertain selector work, reuses the frozen model, and consumes authorization once', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    mocks.select.mockResolvedValueOnce({ status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' })
      .mockResolvedValueOnce({ status: 'COMPLETE', selection });
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0]).toMatchObject({ status: 'RETRY_REQUIRED', videoSelection: { selectionModel: 'selector-model-a' } });
    vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'selector-model-b');
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
    const retried = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(retried.job.slots[0].videoSelection).toMatchObject({ selectionModel: 'selector-model-a', selection });
    expect(mocks.select.mock.calls.map(([arg]) => [arg.cache.model, arg.cache.retry])).toEqual([
      ['selector-model-a', false], ['selector-model-a', true],
    ]);
    expect(retried.job.slots[0].videoSelection.retryAuthorization).toBeUndefined();
  });

  it('retains a completed selection through render failure and explicit Retry reuses it without another selector call', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.render.mockRejectedValueOnce(new Error('render failed'));
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0]).toMatchObject({ status: 'RETRY_REQUIRED', videoSelection: { selection } });
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
    const retried = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(retried.job.slots[0].status).toBe('SAVED'); expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledTimes(2);
  });

  it('fails closed when persisted selection hydration is stale instead of rendering generic fallback frames', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.hydrate.mockRejectedValueOnce(new Error('unknown frame ID'));
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0]).toMatchObject({ status: 'RETRY_REQUIRED', videoSelection: { selection } });
    expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['explicit frame selection', automaticRequest({ videoFrameSelection: selection }), {}],
    ['approved human', automaticRequest(), { approvedHuman: true }],
    ['TRA reference provider image', automaticRequest(), { providerImageSource: {} }],
    ['non-video portfolio', portfolioRequest(), {}],
  ])('preserves %s behavior outside automatic B3 selection', async (_name, request, mode) => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage, request as any);
    const context = contextFor(job, mode.providerImageSource ? { providerImageSource: mode.providerImageSource } : {});
    if (mode.approvedHuman) context.batchPlan.creatives[0].strategy.approvedHumanId = 'approved-human-test';
    mocks.restore.mockResolvedValue(context);
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0].status).toBe('SAVED'); expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.render).toHaveBeenCalledOnce();
  });
});
