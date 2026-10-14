import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { createCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { proposeCaseAmendment, selectedCaseAssertion } from '@/lib/creatives/portfolio-case-amendment';
import { applyCaseAmendment } from '@/lib/creatives/portfolio-case-amendment-storage';
import { claimCreativePortfolio, finishPortfolioPlan, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { approvedHumanSourceId } from '@/lib/video/approved-human';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, HUMAN_FRAME_SELECTION_POLICY, VideoHumanSelectionAdmissionError } from '@/lib/video/human-frame-selection';
import { videoCasePortfolio } from '../fixtures/video-case-portfolio';
import { caseReviewChoices } from '@/lib/creatives/portfolio-case-amendment';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
import { portfolioSnapshot, MemoryPortfolioStorage, portfolioRequest } from '../fixtures/creative-portfolio';

const mocks = vi.hoisted(() => ({
  restore: vi.fn(), render: vi.fn(), preflight: vi.fn(), select: vi.fn(), hydrate: vi.fn(), inventory: vi.fn(), list: vi.fn(), quota: vi.fn(), resolveHuman: vi.fn(), reviewDraft: vi.fn(), reviewSource: vi.fn(),
}));
vi.mock('@/lib/video/review-selection-store', () => ({ loadVideoReviewDraftWithFrameContext: mocks.reviewDraft }));
vi.mock('@/lib/video/review-selection-sources', async original => ({ ...await original<typeof import('@/lib/video/review-selection-sources')>(),
  loadReviewVideoSource: mocks.reviewSource }));
vi.mock('@/lib/creatives/portfolio-snapshot', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-snapshot')>(), restoreCreativePortfolio: mocks.restore,
}));
vi.mock('@/lib/creatives/render-planned', () => ({ renderPlannedCreative: mocks.render }));
vi.mock('@/lib/video/approved-human-service', () => ({ resolveApprovedHumanFrame: mocks.resolveHuman }));
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
const sourceHash = createHash('sha256').update(Buffer.from('video')).digest('hex');
const libraryId = `video-library:${'c'.repeat(64)}`;
const candidateFrameSha256 = 'e'.repeat(64), librarySha256 = 'f'.repeat(64), timestampMs = 1200;
const frameId = videoCandidateFrameId(sourceHash, timestampMs, candidateFrameSha256);
const framePng = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#9a7550' } }).png().toBuffer();
const framePngHash = createHash('sha256').update(framePng).digest('hex');
const selection = { version: 3 as const, libraryId, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
  librarySha256, frameIds: [frameId], candidateBindings: [{ frameId, representativeFrameId: frameId,
    candidateIndex: 0, timestampMs, frameSha256: candidateFrameSha256 }],
  sourceOverlays: [{ version: 2 as const, status: 'CLEAN' as const }] };
const provenance = [{ frameIndex: 0, libraryFrameId: frameId, candidateFrameSha256,
  timestampMs, approvedPngSha256: framePngHash, representativeFrameId: frameId, candidateIndex: 0 }];
const videoSource = { role: 'TRA_VIDEO', media: { id: mediaId, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO',
  size: 5, url: '/source.mp4' }, stored: { fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', buffer: Buffer.from('video') } };
const selectedFrames = { source: videoSource, sourceVideoContentHash: sourceHash, durationMs: 2000, reused: false,
  frames: [{ frameIndex: 0, timestampMs: 1200, mimeType: 'image/png', buffer: framePng, frameSha256: framePngHash,
    byteLength: framePng.length, sourceRole: 'TRA_VIDEO', sourceVideoMediaId: mediaId, sourceVideoFileName: 'source.mp4',
    sourceVideoContentHash: sourceHash, approvedHumanSource: true, cacheKey: null,
    sourceOverlay: { version: 2 as const, status: 'CLEAN' as const } }], selectionProvenance: provenance };
const automaticRequest = (extra: Record<string, unknown> = {}) => ({ ...portfolioRequest(),
  sourceAssets: [{ role: 'TRA_VIDEO' as const, mediaId }], ...extra }) as any;
const quotaGroups = () => mocks.quota.mock.calls.map(([arg]) => arg.group);

async function ready(storage: MemoryPortfolioStorage, request = automaticRequest(), human = true) {
  const now = Date.now() - 1000;
  const created = await createCreativePortfolio(request, storage, now);
  return updateCreativePortfolio(created.id, current => {
    const token = 'planning-lease';
    const claimed = claimCreativePortfolio(current, now + 10, token).job;
    const snapshot = portfolioSnapshot(current);
    if (human) snapshot.batchPlan.creatives.forEach(concept => { concept.strategy.execution.subjectSource = 'approved-tra-human'; });
    return finishPortfolioPlan(claimed, token, snapshot, now + 20);
  }, storage);
}
const contextFor = (job: Awaited<ReturnType<typeof ready>>, overrides: Record<string, unknown> = {}) => ({
  ...job.snapshot!, sourceAnalysis: { version: 1, entries: [] }, storage: {}, brandLogo: null, reserveLogoArea: false,
  providerImageSource: undefined, videoFrameSet: selectedFrames, ...overrides,
}) as any;

beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'selector-model-a');
  mocks.list.mockResolvedValue([]); mocks.quota.mockResolvedValue({ allowed: true });
  mocks.inventory.mockResolvedValue([{ source: videoSource }]);
  mocks.preflight.mockResolvedValue({ status: 'READY' });
  mocks.select.mockResolvedValue({ status: 'COMPLETE', selection }); mocks.hydrate.mockResolvedValue(selectedFrames);
  mocks.resolveHuman.mockResolvedValue({ record: { source: { sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash } }, selected: selectedFrames });
  mocks.render.mockImplementation(async (_concept, _context, options) => ({ id: options.creativeId }));
});

describe('durable portfolio B3 selection activation', () => {
  it('skips selection, extraction and quota for a final non-human concept while retaining video planning', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage, automaticRequest(), false);
    mocks.restore.mockResolvedValue(contextFor(job));
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0].status).toBe('SAVED');
    expect(result.job.slots[0].videoSelection).toBeUndefined();
    expect(mocks.render.mock.calls[0][0].strategy.execution.subjectSource).toBe('non-human');
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.resolveHuman).not.toHaveBeenCalled();
    expect(quotaGroups()).toEqual(['CREATIVE_GENERATION']);
  });

  it('resumes an old blocked non-human slot without reusing its frame choice', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage, automaticRequest(), false);
    await updateCreativePortfolio(job.id, current => {
      const next = structuredClone(current);
      next.slots[0] = { ...next.slots[0], status: 'BLOCKED', error: 'No suitable human frame',
        videoSelection: { version: 2, selectionModel: 'old-model', selectionPolicy: HUMAN_FRAME_SELECTION_POLICY,
          reuseContext: { version: 1, frames: [] } } };
      return next;
    }, storage);
    mocks.restore.mockResolvedValue(contextFor(job));
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0]).toMatchObject({ status: 'SAVED' });
    expect(result.job.slots[0].videoSelection).toBeUndefined();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(quotaGroups()).toEqual(['CREATIVE_GENERATION']);
  });

  it('persists a cold automatic selection without rendering or consuming render quota', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0]).toMatchObject({ status: 'PENDING', videoSelection: { version: 2,
      selectionModel: 'selector-model-a', selectionPolicy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY,
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
    expect(mocks.select.mock.calls[0][0]).toMatchObject({ selectionPolicy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY,
      reuseContext: { version: 1, frames: [] } });
    expect(mocks.select.mock.calls[1][0]).toMatchObject({ selectionPolicy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY,
      reuseContext: { version: 1, frames: [{ libraryId, frameId, useCount: 1 }] } });
  });

  it('surfaces no suitable human candidate as an actionable failure without rendering', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); const context = contextFor(job);
    context.batchPlan.creatives[0].strategy.execution.subjectSource = 'approved-tra-human';
    mocks.restore.mockResolvedValue(context); mocks.select.mockResolvedValueOnce({ status: 'NO_SUITABLE_HUMAN' });
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result).toMatchObject({ status: 409, error: expect.stringContaining('No suitable human frame') });
    expect(result.job.slots[0]).toMatchObject({ status: 'BLOCKED',
      videoSelection: { selectionPolicy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } });
    expect(result.job.lease).toBeNull(); expect(() => retryPortfolioWork(result.job, 1)).toThrow('does not require a retry');
    expect(quotaGroups()).toEqual(['VIDEO_SELECTION']); expect(mocks.render).not.toHaveBeenCalled();
  });

  it('blocks a completed no-suitable preflight before selection quota or a selector call', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); const context = contextFor(job);
    context.batchPlan.creatives[0].strategy.execution.subjectSource = 'approved-tra-human';
    mocks.restore.mockResolvedValue(context); mocks.preflight.mockResolvedValueOnce({ status: 'NO_SUITABLE_HUMAN' });
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result).toMatchObject({ status: 409, job: { lease: null } });
    expect(result.job.slots[0]).toMatchObject({ status: 'BLOCKED' });
    expect(quotaGroups()).toEqual([]); expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
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
      generatedVideoFrameSelection: { libraryId, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
        librarySha256, frames: provenance } });
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
    expect(mocks.hydrate).toHaveBeenCalledOnce(); expect(mocks.render).not.toHaveBeenCalled();
  });

  it.each(['crop mismatch', 'provider hash mismatch'] as const)(
    'rejects %s before creative quota or rendering', async problem => {
      const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
      await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      const frame = { ...selectedFrames.frames[0], sourceOverlay: { version: 2 as const, status: 'EDGE_CROP' as const,
        edge: 'BOTTOM' as const, removePermille: 400, overlayDepthPermille: 390 },
        expectedCrop: problem === 'crop mismatch' ? { left: 0, top: 0, width: 100, height: 59 }
          : { left: 0, top: 0, width: 100, height: 60 }, expectedProviderPngSha256: '0'.repeat(64) };
      mocks.hydrate.mockResolvedValueOnce({ ...selectedFrames, frames: [frame] });
      const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      expect(result.status).toBe(409);
      expect(result.job.slots[0].status).toBe('RETRY_REQUIRED');
      expect(quotaGroups()).toEqual(['VIDEO_SELECTION']);
      expect(mocks.render).not.toHaveBeenCalled();
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

  it('blocks a saved v1 human choice before quota and reselects only after explicit Retry', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage); mocks.restore.mockResolvedValue(contextFor(job));
    await updateCreativePortfolio(job.id, current => {
      const next = structuredClone(current);
      next.slots[0].videoSelection = { version: 2, selectionModel: 'old-model',
        selectionPolicy: 'human-frame-visual-quality-v1', reuseContext: { version: 1, frames: [] },
        selection: { libraryId, sourceVideoContentHash: sourceHash, frameIds: [frameId] } };
      return next;
    }, storage);
    const blocked = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(blocked).toMatchObject({ status: 409, job: { slots: [{ status: 'RETRY_REQUIRED' }, expect.any(Object)] } });
    expect(quotaGroups()).toEqual([]); expect(mocks.render).not.toHaveBeenCalled();
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
    const selected = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(selected.job.slots[0]).toMatchObject({ status: 'PENDING', videoSelection: { selection } });
    expect(mocks.select).toHaveBeenCalledOnce();
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

  it.each(['UNSAFE', 'crop mismatch', 'provider hash mismatch'] as const)(
    'rejects an explicit saved %s frame before generation quota', async problem => {
      const storage = new MemoryPortfolioStorage();
      const job = await ready(storage, automaticRequest({ videoFrameSelection: selection }));
      const frame = { ...selectedFrames.frames[0],
        sourceOverlay: problem === 'UNSAFE' ? { version: 2 as const, status: 'UNSAFE' as const }
          : { version: 2 as const, status: 'EDGE_CROP' as const, edge: 'BOTTOM' as const,
            removePermille: 400, overlayDepthPermille: 390 },
        ...(problem === 'crop mismatch' ? { expectedCrop: { left: 0, top: 0, width: 100, height: 59 } } : {}),
        ...(problem === 'provider hash mismatch' ? { expectedProviderPngSha256: '0'.repeat(64) } : {}),
      };
      mocks.restore.mockResolvedValue(contextFor(job, { videoFrameSet: { ...selectedFrames, frames: [frame] } }));
      const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      expect(result).toMatchObject({ status: 409, job: { slots: [{ status: 'RETRY_REQUIRED' }, expect.anything()] } });
      expect(quotaGroups()).toEqual([]);
      expect(mocks.render).not.toHaveBeenCalled();
    });

  it.each(['humanSourceId', 'approvedHumanId'] as const)(
    'rejects an unsafe curated %s before generation quota', async key => {
      const storage = new MemoryPortfolioStorage(), job = await ready(storage);
      const context = contextFor(job);
      context.batchPlan.creatives[0].strategy[key] = key === 'humanSourceId'
        ? approvedHumanSourceId(`human_${'1'.repeat(64)}`) : `human_${'1'.repeat(64)}`;
      mocks.restore.mockResolvedValue(context);
      mocks.resolveHuman.mockResolvedValue({ record: { source: {} }, selected: { ...selectedFrames,
        frames: [{ ...selectedFrames.frames[0], sourceOverlay: { version: 2, status: 'UNSAFE' } }] } });
      const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      expect(result.status).toBe(409);
      expect(result.job.slots[0].status).toBe('RETRY_REQUIRED');
      expect(quotaGroups()).toEqual([]);
      expect(mocks.render).not.toHaveBeenCalled();
    });

  it('renders an explicitly selected cleanly cropped frame after generation quota', async () => {
    const storage = new MemoryPortfolioStorage();
    const job = await ready(storage, automaticRequest({ videoFrameSelection: selection }));
    const frame = { ...selectedFrames.frames[0], sourceOverlay: { version: 2 as const, status: 'EDGE_CROP' as const,
      edge: 'BOTTOM' as const, removePermille: 400, overlayDepthPermille: 390 },
      expectedCrop: { left: 0, top: 0, width: 600, height: 540 } };
    mocks.restore.mockResolvedValue(contextFor(job, { videoFrameSet: { ...selectedFrames, frames: [frame] } }));
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0].status).toBe('SAVED');
    expect(quotaGroups()).toEqual(['CREATIVE_GENERATION']);
    expect(mocks.render.mock.calls[0][2].preflightHumanVideo.videoFrames.frames).toEqual([frame]);
  });
});

const manualRequest = (frames: typeof selection.candidateBindings | null = selection.candidateBindings) => {
  const video = { locator: { version: 1, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
    analyzerFingerprintSha256: '1'.repeat(64) }, libraryId, librarySha256, preparationSha256: '2'.repeat(64) };
  const draftId = `review_${'3'.repeat(32)}`;
  mocks.reviewSource.mockResolvedValue({});
  mocks.reviewDraft.mockResolvedValue({ revision: 'saved', issues: [], transcriptContext: null,
    selectedFrameContexts: frames?.map(binding => ({ binding })) ?? null,
    draft: { id: draftId, choices: { video, frames, claims: null, companyProfile: null }, claimSnapshots: [] } });
  return automaticRequest({ videoReview: { draftId, revision: 'saved' } });
};

it('manual review takes priority over catalog/image sources through saved selection and Resume', async () => {
  const storage = new MemoryPortfolioStorage(), job = await ready(storage, manualRequest());
  const context = contextFor(job, { providerImageSource: { media: { id: 'other' } }, videoFrameSet: null });
  context.batchPlan.creatives[0].strategy.humanSourceId = approvedHumanSourceId(`human_${'4'.repeat(64)}`);
  mocks.restore.mockResolvedValue(context);
  const selected = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(selected.job.slots[0].videoSelection?.selection).toEqual(selection);
  expect(mocks.select.mock.calls[0][0].reviewChoices).toEqual(job.request.reviewHandoff!.choices);
  mocks.reviewDraft.mockRejectedValue(new Error('Mutable draft cannot be reloaded'));
  const rendered = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(rendered.job.slots[0].status).toBe('SAVED'); expect(mocks.select).toHaveBeenCalledOnce();
  expect(mocks.render.mock.calls[0][1]).toMatchObject({ providerImageSource: undefined, videoFrameSet: selectedFrames });
  expect(mocks.render.mock.calls[0][2].preflightHumanVideo).toEqual({ human: null, videoFrames: selectedFrames });
  expect(mocks.resolveHuman).not.toHaveBeenCalled(); expect(mocks.reviewDraft).toHaveBeenCalledOnce();
  expect(quotaGroups()).toEqual(['VIDEO_SELECTION', 'CREATIVE_GENERATION']);
});

it('manual assessment failure requires explicit Retry and retains the same frozen pool', async () => {
  const storage = new MemoryPortfolioStorage(), job = await ready(storage, manualRequest()); mocks.restore.mockResolvedValue(contextFor(job));
  mocks.select.mockResolvedValueOnce({ status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' });
  const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(failed.job.slots[0].status).toBe('RETRY_REQUIRED');
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(mocks.select.mock.calls.filter(([input]) => input.finalConcept.index === 1)).toHaveLength(1);
  await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(mocks.select.mock.calls.at(-1)![0]).toMatchObject({ reviewChoices: job.request.reviewHandoff!.choices, cache: { retry: true } });
  expect(mocks.render).not.toHaveBeenCalled();
});

it.each([null, []])('keeps automatic rendering available with empty manual pool %j', async frames => {
  const storage = new MemoryPortfolioStorage(), job = await ready(storage, manualRequest(frames)); mocks.restore.mockResolvedValue(contextFor(job));
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(mocks.select).toHaveBeenCalledOnce(); expect(mocks.render).toHaveBeenCalledOnce();
  expect(mocks.render.mock.calls[0][2].preflightHumanVideo).toBeUndefined();
});

async function readyTwoCases(storage: MemoryPortfolioStorage) {
  const secondFrame = { frameId: videoCandidateFrameId(sourceHash, 5000, '9'.repeat(64)),
    representativeFrameId: videoCandidateFrameId(sourceHash, 5000, '9'.repeat(64)), candidateIndex: 1,
    timestampMs: 5000, frameSha256: '9'.repeat(64) };
  const request = manualRequest([...selection.candidateBindings, secondFrame]);
  const loaded = await mocks.reviewDraft();
  const segments = [{ segmentIndex: 0, startMs: 0, endMs: 2000, text: 'My debt went from $42,000 to $250. This was my case.' },
    { segmentIndex: 1, startMs: 4000, endMs: 7000, text: 'TRA reduced what I owed by 78%. This was my experience.' }];
  const claimSnapshots = segments.map(segment => ({ reference: { type: 'VIDEO_TRANSCRIPT', startSegmentIndex: segment.segmentIndex,
    endSegmentIndex: segment.segmentIndex }, wording: segment.text, context: { type: 'VIDEO_TRANSCRIPT', segments: [segment] } }));
  loaded.draft.claimSnapshots = claimSnapshots; loaded.draft.choices.claims = claimSnapshots.map(claim => claim.reference);
  loaded.selectedFrameContexts = loaded.selectedFrameContexts.map((context: object, index: number) => ({ ...context,
    observationIsExactFrame: true, observation: { sceneType: 'PERSON', summary: index ? 'Bearded person outdoors' : 'Bald person indoors',
      visibleText: [], composition: 'Portrait', topics: ['person'], uncertainties: [] } }));
  mocks.reviewDraft.mockResolvedValue(loaded);
  return { job: await ready(storage, request), secondFrame, segments };
}

it('holds an unbound manual source account before leases, assessment or quota, leaving amendment available', async () => {
  const storage = new MemoryPortfolioStorage(), { job } = await readyTwoCases(storage);
  // Represent a historical paid plan, without changing its later immutable saved snapshot.
  const stored = (await storage.read(`creative-portfolios/v1/${job.id}.json`))!;
  job.snapshot!.batchPlan.creatives[0].draftSourceAssertion = selectedCaseAssertion(job.request.reviewHandoff, 0);
  job.snapshot!.batchPlan.creatives[0].imageCopy!.shortSupport = job.snapshot!.batchPlan.creatives[0].draftSourceAssertion.exactText;
  job.snapshot!.batchPlan.creatives[0].adCopy!.primaryText = job.snapshot!.batchPlan.creatives[0].draftSourceAssertion.exactText;
  await storage.write(`creative-portfolios/v1/${job.id}.json`, Buffer.from(JSON.stringify(job)), stored.etag);
  const before = (await storage.read(`creative-portfolios/v1/${job.id}.json`))!.bytes;
  const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(result.status).toBe(409); expect(result.error).toContain('confirmed person pairing');
  expect(result.job.slots[0].status).toBe('PENDING'); expect(result.job.lease).toBeNull();
  expect((await storage.read(`creative-portfolios/v1/${job.id}.json`))!.bytes).toEqual(before);
  expect(mocks.restore).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled(); expect(quotaGroups()).toEqual([]);
});

it('sends each amended case’s exact one-frame pool to selection, hydration and renderer, and rejects wrong-person completion', async () => {
  const storage = new MemoryPortfolioStorage(), { job, secondFrame, segments } = await readyTwoCases(storage);
  const pairs = [selection.candidateBindings[0], secondFrame].map((frame, index) => ({ slotIndex: index + 1,
    claimIndex: index, frameId: frame.frameId, attributionConfirmed: true }));
  const amended = await applyCaseAmendment(job.id, proposeCaseAmendment(job, pairs).amendment, storage);
  mocks.restore.mockResolvedValue(contextFor(amended));
  vi.stubEnv('OPENAI_API_KEY', 'offline-fixture');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
    humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE', blur: 'CLEAR', occlusion: 'NONE_OR_MINOR',
    expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE', observableReason: 'Synthetic fixture.', sourceOverlay: { version: 2, status: 'CLEAN' },
  }) }] }] })));
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(mocks.preflight.mock.calls[0][0].reviewChoices.frames).toEqual([selection.candidateBindings[0]]);
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(mocks.hydrate.mock.calls[0][0].reviewChoices.frames).toEqual([selection.candidateBindings[0]]);
  expect(mocks.render).not.toHaveBeenCalled();
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(mocks.render.mock.calls[0][0].imageCopy.shortSupport).toBe(segments[0].text);
  const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(mocks.select.mock.calls[1][0].reviewChoices.frames).toEqual([secondFrame]);
  expect(mocks.select.mock.calls[1][0].finalConcept.imageCopy.shortSupport).toBe(segments[1].text);
  expect(failed.job.slots[1].status).toBe('RETRY_REQUIRED'); expect(mocks.render).toHaveBeenCalledOnce();
  expect(failed.job.slots[1].error).toContain('closed-pool');
});

it('holds attribution inside the atomic claim when concurrent planning finishes after the initial read', async () => {
  const storage = new MemoryPortfolioStorage(), { job } = await readyTwoCases(storage);
  const concept = job.snapshot!.batchPlan.creatives[0];
  concept.draftSourceAssertion = selectedCaseAssertion(job.request.reviewHandoff, 0);
  concept.imageCopy!.shortSupport = concept.draftSourceAssertion.exactText;
  concept.adCopy!.primaryText = concept.draftSourceAssertion.exactText;
  concept.copy.primaryText = concept.draftSourceAssertion.exactText;
  const initial = { ...structuredClone(job), snapshot: null, planning: { phase: 'INITIAL_PLAN' as const, preparation: { quotaReserved: false } } };
  const key = `creative-portfolios/v1/${job.id}.json`, prior = (await storage.read(key))!;
  await storage.write(key, Buffer.from(JSON.stringify(initial)), prior.etag);
  const read = storage.read.bind(storage); let first = true;
  storage.read = async path => {
    const state = await read(path);
    if (first && path === key) {
      first = false;
      // Another worker commits its valid final planning checkpoint while this caller still sees INITIAL_PLAN.
      await storage.write(key, Buffer.from(JSON.stringify(job)), state!.etag);
    }
    return state;
  };
  const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(result.status).toBe(409); expect(result.error).toContain('confirmed person pairing');
  expect(result.job.slots.every(slot => slot.status === 'PENDING' && !slot.videoSelection)).toBe(true);
  expect(result.job.lease).toBeNull();
  expect(mocks.restore).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled(); expect(quotaGroups()).toEqual([]);
  expect(JSON.parse((await read(key))!.bytes.toString())).toEqual(job);
});


describe('bound case exact provider PNG admission', () => {
  async function setupBound() {
    const { job, pairs } = videoCasePortfolio(); job.videoCaseAmendment = proposeCaseAmendment(job, pairs).amendment;
    job.slots[0].status = 'SAVED';
    const choices = caseReviewChoices(job, 2)!, binding = choices.frames![0], video = choices.video!;
    const png = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#a57755' } }).png().toBuffer();
    const hash = createHash('sha256').update(png).digest('hex');
    const selected = { version: 3 as const, libraryId: video.libraryId, librarySha256: video.librarySha256,
      sourceVideoMediaId: video.locator.sourceVideoMediaId, sourceVideoContentHash: video.locator.sourceVideoContentHash,
      frameIds: [binding.frameId], candidateBindings: [binding], sourceOverlays: [{ version: 2 as const, status: 'EDGE_CROP' as const,
        edge: 'BOTTOM' as const, removePermille: 350, overlayDepthPermille: 340 }] };
    job.slots[1].videoSelection = { version: 2, selectionModel: 'gpt-6-luna', selectionPolicy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY,
      reuseContext: { version: 1, frames: [] }, selection: selected };
    const storage = new MemoryPortfolioStorage();
    await storage.write(`creative-portfolios/v1/${job.id}.json`, Buffer.from(JSON.stringify(job)), null);
    mocks.restore.mockResolvedValue(contextFor(job));
    mocks.hydrate.mockImplementation(async () => ({ ...selectedFrames, sourceVideoContentHash: video.locator.sourceVideoContentHash,
      source: { ...videoSource, media: { ...videoSource.media, id: video.locator.sourceVideoMediaId } },
      frames: [{ ...selectedFrames.frames[0], timestampMs: binding.timestampMs, buffer: Buffer.from(png), frameSha256: hash,
        byteLength: png.length, sourceVideoMediaId: video.locator.sourceVideoMediaId,
        sourceVideoContentHash: video.locator.sourceVideoContentHash, sourceOverlay: selected.sourceOverlays[0] }],
      selectionProvenance: [{ ...provenance[0], libraryFrameId: binding.frameId, representativeFrameId: binding.representativeFrameId,
        candidateIndex: binding.candidateIndex, timestampMs: binding.timestampMs, candidateFrameSha256: binding.frameSha256, approvedPngSha256: hash }] }));
    vi.stubEnv('OPENAI_API_KEY', 'offline-fixture');
    return { job, storage };
  }
  const assessment = (extra = {}) => ({ humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE',
    blur: 'CLEAR', occlusion: 'NONE_OR_MINOR', expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE',
    observableReason: 'Synthetic fixture.', sourceOverlay: { version: 2, status: 'CLEAN' }, ...extra });
  const complete = (a: object) => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(a) }] }] });
  it('checkpoints assessment before image admission and attaches the exact verified PNG on continuation', async () => {
    const { job, storage } = await setupBound(), assessed: Buffer[] = [];
    const request = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.input[1].content[1].image_url).toMatch(/^data:image\/png;base64,/);
      assessed.push(Buffer.from(body.input[1].content[1].image_url.split(',')[1], 'base64')); return complete(assessment());
    }); vi.stubGlobal('fetch', request);
    const prepared = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(prepared.job.slots[0]).toEqual(job.slots[0]); expect(prepared.job.slots[1].videoSelection)
      .toMatchObject({ providerPortrait: { verified: true } });
    expect(quotaGroups()).toEqual(['VIDEO_SELECTION']); expect(mocks.render).not.toHaveBeenCalled();
    mocks.render.mockImplementation(async (_concept, context, options) => {
      const [attached] = await prepareProviderVideoFrames(context.videoFrameSet.frames);
      expect(attached.providerBuffer).toEqual(assessed[0]); return { id: options.creativeId };
    });
    const rendered = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(rendered.job.slots[1].status).toBe('SAVED'); expect(rendered.job.slots[0]).toEqual(job.slots[0]);
    expect(request).toHaveBeenCalledOnce(); expect(quotaGroups()).toEqual(['VIDEO_SELECTION', 'CREATIVE_GENERATION']);
  });
  it('rejects PNG drift after the checkpoint before another assessment or image quota', async () => {
    const { job, storage } = await setupBound(), request = vi.fn(async () => complete(assessment())); vi.stubGlobal('fetch', request);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const originalHydrate = mocks.hydrate.getMockImplementation()!;
    mocks.hydrate.mockImplementation(async (...args) => {
      const value = await originalHydrate(...args), changed = await sharp(value.frames[0].buffer).negate().png().toBuffer();
      value.frames[0] = { ...value.frames[0], buffer: changed, frameSha256: createHash('sha256').update(changed).digest('hex'), byteLength: changed.length };
      return value;
    });
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.error).toContain('pinned portrait PNG or crop changed'); expect(mocks.render).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce(); expect(quotaGroups()).toEqual(['VIDEO_SELECTION']);
  });
  it('rejects actual residual marks without image admission and never automatically re-assesses them', async () => {
    const { job, storage } = await setupBound(), request = vi.fn(async () => complete(assessment({ sourceOverlay: { version: 2, status: 'UNSAFE' } })));
    vi.stubGlobal('fetch', request);
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.error).toContain('actual retained portrait PNG'); expect(mocks.render).not.toHaveBeenCalled();
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(request).toHaveBeenCalledOnce(); expect(quotaGroups()).toEqual(['VIDEO_SELECTION']);
  });
  it('requires explicit Retry for an uncertain PNG assessment and preserves its pinned input', async () => {
    const { job, storage } = await setupBound(), request = vi.fn().mockRejectedValueOnce(new Error('uncertain'))
      .mockResolvedValue(complete(assessment())); vi.stubGlobal('fetch', request);
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[1].status).toBe('RETRY_REQUIRED'); const before = failed.job.slots[1].videoSelection;
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage); expect(request).toHaveBeenCalledOnce();
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 2), storage);
    const passed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(passed.job.slots[1].videoSelection).toMatchObject({ providerPortrait: { verified: true } });
    expect((passed.job.slots[1].videoSelection as any).providerPortrait.sourcePngSha256).toBe((before as any).providerPortrait.sourcePngSha256);
    expect(mocks.render).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
  });
});
