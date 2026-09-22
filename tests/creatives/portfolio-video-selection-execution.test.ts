import { beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { createCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { claimCreativePortfolio, finishPortfolioPlan, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { approvedHumanSourceId } from '@/lib/video/approved-human';
import { HUMAN_FRAME_SELECTION_POLICY, METADATA_FRAME_SELECTION_POLICY, VideoHumanSelectionAdmissionError } from '@/lib/video/human-frame-selection';
import { portfolioSnapshot, MemoryPortfolioStorage, portfolioRequest } from '../fixtures/creative-portfolio';

const mocks = vi.hoisted(() => ({
  restore: vi.fn(), render: vi.fn(), preflight: vi.fn(), select: vi.fn(), hydrate: vi.fn(), inventory: vi.fn(), list: vi.fn(), quota: vi.fn(),
}));
vi.mock('@/lib/creatives/portfolio-snapshot', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-snapshot')>(), restoreCreativePortfolio: mocks.restore,
}));
vi.mock('@/lib/creatives/render-planned', () => ({ renderPlannedCreative: mocks.render }));
vi.mock('@/lib/creatives/portfolio-video-selection', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-video-selection')>(),
  preflightPortfolioVideoFrames: mocks.preflight, selectPortfolioVideoFrames: mocks.select,
  hydratePortfolioVideoFrameSelection: mocks.hydrate,
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
const quotaGroups = () => mocks.quota.mock.calls.map(([arg]) => arg.group);

async function ready(storage: MemoryPortfolioStorage, request = automaticRequest()) {
  const now = Date.now() - 1000;
  const created = await createCreativePortfolio(request, storage, now);
  return updateCreativePortfolio(created.id, current => {
    const token = 'planning-lease';
    const claimed = claimCreativePortfolio(current, now + 10, token).job;
    return finishPortfolioPlan(claimed, token, portfolioSnapshot(current), now + 20);
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
  mocks.preflight.mockResolvedValue({ status: 'READY' });
  mocks.select.mockResolvedValue({ status: 'COMPLETE', selection }); mocks.hydrate.mockResolvedValue(selectedFrames);
  mocks.render.mockImplementation(async (_concept, _context, options) => ({ id: options.creativeId }));
});

describe('durable portfolio B3 selection activation', () => {
  it('persists a cold automatic selection without rendering or consuming render quota', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0]).toMatchObject({ status: 'PENDING', videoSelection: { version: 2,
      selectionModel: 'selector-model-a', selectionPolicy: METADATA_FRAME_SELECTION_POLICY,
      reuseContext: { version: 1, frames: [] }, selection } });
    expect(result.job.lease).toBeNull(); expect(mocks.render).not.toHaveBeenCalled();
    expect(quotaGroups()).toEqual(['VIDEO_SELECTION']);
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ finalConcept: expect.any(Object),
      cache: expect.objectContaining({ model: 'selector-model-a', retry: false }) }));
  });

  it('freezes human visual policy and carries persisted same-portfolio selections into the next slot', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); const context = contextFor(job);
    context.batchPlan.creatives = context.batchPlan.creatives.map((item: any) => ({ ...item, strategy: { ...item.strategy,
      execution: { ...item.strategy.execution, subjectSource: 'approved-tra-human' } } }));
    mocks.restore.mockResolvedValue(context);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(mocks.select.mock.calls[0][0]).toMatchObject({ selectionPolicy: HUMAN_FRAME_SELECTION_POLICY,
      reuseContext: { version: 1, frames: [] } });
    expect(mocks.select.mock.calls[1][0]).toMatchObject({ selectionPolicy: HUMAN_FRAME_SELECTION_POLICY,
      reuseContext: { version: 1, frames: [{ libraryId, frameId, useCount: 1 }] } });
  });

  it('surfaces no suitable human candidate as an actionable failure without rendering', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); const context = contextFor(job);
    context.batchPlan.creatives[0].strategy.execution.subjectSource = 'approved-tra-human';
    mocks.restore.mockResolvedValue(context); mocks.select.mockResolvedValueOnce({ status: 'NO_SUITABLE_HUMAN' });
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result).toMatchObject({ status: 409, error: expect.stringContaining('No suitable human frame') });
    expect(result.job.slots[0]).toMatchObject({ status: 'RETRY_REQUIRED',
      videoSelection: { selectionPolicy: HUMAN_FRAME_SELECTION_POLICY } });
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('propagates local visual-selection admission failure without rendering', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); const context = contextFor(job);
    context.batchPlan.creatives[0].strategy.execution.subjectSource = 'approved-tra-human';
    mocks.restore.mockResolvedValue(context);
    mocks.preflight.mockRejectedValueOnce(new VideoHumanSelectionAdmissionError('Visual human selection requires 128128 output tokens for 788 images.'));
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result).toMatchObject({ status: 409, error: expect.stringContaining('requires 128128 output tokens') });
    expect(result.job.slots[0]).toMatchObject({ status: 'BLOCKED', error: expect.stringContaining('smaller video pool') });
    expect(() => retryPortfolioWork(result.job, 1)).toThrow('does not require a retry');
    expect(quotaGroups()).toEqual([]); expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
  });

  it('hydrates and renders only the persisted selection with creative-generation admission', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0].status).toBe('SAVED'); expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledWith(expect.objectContaining({ selection }));
    expect(mocks.render.mock.calls[0][1]).toMatchObject({ videoFrameSet: selectedFrames,
      generatedVideoFrameSelection: { libraryId, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash, frames: provenance } });
    expect(quotaGroups()).toEqual(['VIDEO_SELECTION', 'CREATIVE_GENERATION']);
  });

  it('denies selection quota before selector/provider work and releases the parent lease', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    mocks.quota.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 });
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result).toMatchObject({ status: 429, retryAfterSeconds: 17, job: { lease: null } });
    expect(quotaGroups()).toEqual(['VIDEO_SELECTION']); expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
  });

  it('denies render quota after persisted selection without image/provider work', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.quota.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 23 });
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result).toMatchObject({ status: 429, retryAfterSeconds: 23, job: { lease: null } });
    expect(quotaGroups()).toEqual(['VIDEO_SELECTION', 'CREATIVE_GENERATION']);
    expect(mocks.hydrate).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
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
    expect(retried.job.slots[0].videoSelection?.retryAuthorization).toBeUndefined();
    expect(quotaGroups()).toEqual(['VIDEO_SELECTION', 'VIDEO_SELECTION']);
  });

  it('retains a completed selection through render failure and re-admits the explicit render Retry', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.render.mockRejectedValueOnce(new Error('render failed'));
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0]).toMatchObject({ status: 'RETRY_REQUIRED', videoSelection: { selection } });
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
    const retried = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(retried.job.slots[0].status).toBe('SAVED'); expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledTimes(2);
    expect(quotaGroups()).toEqual(['VIDEO_SELECTION', 'CREATIVE_GENERATION', 'CREATIVE_GENERATION']);
  });

  it('fails closed when persisted selection hydration is stale instead of rendering generic fallback frames', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.hydrate.mockRejectedValueOnce(new Error('unknown frame ID'));
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0]).toMatchObject({ status: 'RETRY_REQUIRED', videoSelection: { selection } });
    expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it('keeps a generalized approved human isolated from automatic B3 selection', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage);
    const context = contextFor(job);
    const humanSourceId = approvedHumanSourceId(`human_${'1'.repeat(64)}`);
    context.batchPlan.creatives[0].strategy = {
      ...context.batchPlan.creatives[0].strategy,
      humanSourceId,
      execution: { ...context.batchPlan.creatives[0].strategy.execution, subjectSource: 'approved-tra-human' },
    };
    mocks.restore.mockResolvedValue(context);

    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);

    expect(context.batchPlan.creatives[0].strategy.humanSourceId).toBe(humanSourceId);
    expect(result.job.slots[0].status).toBe('SAVED');
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.render.mock.calls[0][0].strategy.humanSourceId).toBe(humanSourceId);
    expect(quotaGroups()).toEqual(['CREATIVE_GENERATION']);
  });

  it.each([
    ['explicit frame selection', automaticRequest({ videoFrameSelection: selection }), {}],
    ['approved human', automaticRequest(), { approvedHuman: true }],
    ['TRA reference provider image', automaticRequest(), { providerImageSource: {} }],
    ['non-video portfolio', portfolioRequest(), {}],
  ])('preserves %s behavior and creative-generation admission outside automatic B3 selection', async (_name, request, mode) => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage, request as any);
    const flags = mode as { providerImageSource?: unknown; approvedHuman?: boolean };
    const context = contextFor(job, flags.providerImageSource ? { providerImageSource: flags.providerImageSource } : {});
    if (flags.approvedHuman) context.batchPlan.creatives[0].strategy.approvedHumanId = 'approved-human-test';
    mocks.restore.mockResolvedValue(context);
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0].status).toBe('SAVED'); expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.render).toHaveBeenCalledOnce(); expect(quotaGroups()).toEqual(['CREATIVE_GENERATION']);
  });
});
