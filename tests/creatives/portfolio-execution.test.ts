import { beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { newCreativePortfolio, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { portfolioAudit } from '../fixtures/portfolio-audit';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

const mocks = vi.hoisted(() => ({ prepareStep: vi.fn(), plan: vi.fn(), audit: vi.fn(), restore: vi.fn(), render: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/creatives/portfolio-preparation', () => ({ advancePortfolioPreparation: mocks.prepareStep }));
vi.mock('@/lib/ai/creative-planner', () => ({
  requestCreativeBatch: mocks.plan,
  creativeRepairFeedback: (issue: string, audit: unknown) => `\nrepair:${issue}\n${JSON.stringify(audit)}`,
}));
vi.mock('@/lib/ai/portfolio-auditor', () => ({ auditCreativePortfolio: mocks.audit }));
vi.mock('@/lib/creatives/render-planned', () => ({ renderPlannedCreative: mocks.render }));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: mocks.list }));
vi.mock('@/lib/creatives/portfolio-snapshot', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-snapshot')>(), restoreCreativePortfolio: mocks.restore,
}));
let records: CreativeRecord[] = [];
const analysis = { summary: 'Planning source summary', visibleText: [], visualStructure: 'Clear hierarchy', hookOrAngle: 'Clarity',
  offerOrCta: 'Talk with TRA', styleNotes: 'Calm', preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems' as const };
const unAuditedPlan = (request: ReturnType<typeof portfolioRequest>) => {
  const { portfolioAudit: _audit, ...plan } = portfolioSnapshot(newCreativePortfolio(request)).batchPlan;
  return plan;
};
const repeatedAudit = () => ({ ...portfolioAudit(2), groups: [{ conceptIndexes: [1, 2], proposition: 'Same reason to act', distinction: 'Paraphrases' }] });

beforeEach(() => {
  records = []; mocks.prepareStep.mockReset(); mocks.plan.mockReset(); mocks.audit.mockReset(); mocks.restore.mockReset(); mocks.render.mockReset();
  mocks.list.mockReset().mockImplementation(async () => records);
  mocks.plan.mockImplementation(async args => unAuditedPlan(portfolioRequest(args.count)));
  mocks.audit.mockImplementation(async concepts => portfolioAudit(concepts.length));
  mocks.prepareStep.mockImplementation(async (request, _url, _state, onProviderStart) => {
    onProviderStart();
    const plannerArgs = { count: request.variationCount, context: 'Prepared planning context', analysis,
      hasApprovedHumanSource: false, referenceCatalog: [] };
    const batchPlan = await mocks.plan(plannerArgs);
    return { prepared: { request, batchPlan, plannerArgs, referenceCatalog: [], selectedReferences: [], requestedSources: [], analysisSources: [],
      videoFrameSet: null, providerImageSource: null, brandLogo: null, reserveLogoArea: false } };
  });
  mocks.restore.mockImplementation(async snapshot => snapshot);
  mocks.render.mockImplementation(async (concept, context, options) => {
    await options.assertCurrentWork();
    const record: CreativeRecord = { id: options.creativeId, createdAt: '2026-09-11T00:00:00.000Z',
      category: concept.strategy.category, format: concept.format, placement: context.request.placement, copy: concept.copy,
      identity: buildCreativeIdentity({ creativeId: options.creativeId, operation: 'GENERATE', strategy: concept.strategy }),
      image: { id: 'media_' + 'a'.repeat(32), fileName: 'saved.png', originalName: 'saved.png', mimeType: 'image/png', size: 100, url: '/saved.png' } };
    records.push(record);
    return { ...record, index: concept.index };
  });
});

describe('bounded resumable portfolio execution', () => {
  it('persists planning before completing 36 single-image steps without double-charging quotas', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(36), storage);
    let result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning).toMatchObject({ phase: 'INITIAL_PLAN', preparation: { quotaReserved: true } });
    expect(mocks.prepareStep).not.toHaveBeenCalled();
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('DIVERSITY_AUDIT');
    expect(result.job.snapshot).toBeNull();
    expect(mocks.render).not.toHaveBeenCalled();
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('READY_TO_RENDER');
    expect(result.job.snapshot?.batchPlan.creatives).toHaveLength(36);
    for (let index = 1; index <= 36; index++) {
      result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      expect(result.error).toBeUndefined();
      expect(result.job.slots.filter(slot => slot.status === 'SAVED')).toHaveLength(index);
    }
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.render).toHaveBeenCalledTimes(36);
    expect(records.map(record => record.id)).toEqual(job.slots.map(slot => slot.creativeId));
    const quotas = [...storage.data.entries()].filter(([key]) => key.startsWith('quotas/')).map(([, value]) => JSON.parse(value.bytes.toString()));
    expect(quotas).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'CREATIVE_PLANNING', usedUnits: 36 }),
      expect.objectContaining({ group: 'CREATIVE_GENERATION', usedUnits: 36 }),
    ]));
  });

  it('checkpoints pre-plan provider work before starting the next operation', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.prepareStep.mockImplementationOnce(async (_request, _url, state, onProviderStart) => {
      onProviderStart();
      return { state: { ...state, analysis } };
    });
    const checkpointed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(checkpointed.job.planning).toMatchObject({ phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, analysis } });
    expect(mocks.plan).not.toHaveBeenCalled();
    const planned = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(planned.job.planning.phase).toBe('DIVERSITY_AUDIT');
    expect(mocks.prepareStep).toHaveBeenCalledTimes(2);
    expect(mocks.plan).toHaveBeenCalledOnce();
  });

  it('saves audit and repair boundaries and performs only the next provider operation on resume', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    mocks.audit.mockResolvedValueOnce(repeatedAudit()).mockResolvedValueOnce(portfolioAudit(2));
    let result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('INITIAL_PLAN');
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('DIVERSITY_AUDIT');
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('TARGETED_REPAIR');
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning).toMatchObject({ phase: 'DIVERSITY_AUDIT', repairAttempted: true });
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('READY_TO_RENDER');
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
    expect(mocks.plan).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    const planningQuota = [...storage.data.entries()].filter(([key]) => key.includes('/CREATIVE_PLANNING.json')).map(([, value]) => JSON.parse(value.bytes.toString()));
    expect(planningQuota).toEqual([expect.objectContaining({ usedUnits: 2 })]);
  });

  it('retries an interrupted audit explicitly without repeating the completed initial plan', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.audit.mockRejectedValueOnce(new Error('Audit connection lost'));
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job).toMatchObject({ planning: { phase: 'DIVERSITY_AUDIT' }, planningError: expect.any(String) });
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
    const retried = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(retried.job.planning.phase).toBe('READY_TO_RENDER');
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent advances and pauses known quota denials before provider work', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(36), storage);
    await Promise.all([1, 2].map(() => advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage)));
    expect(mocks.prepareStep).not.toHaveBeenCalled();
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
    const second = await createCreativePortfolio(portfolioRequest(36), storage);
    const denied = await advanceCreativePortfolio(second.id, 'operator', 'http://localhost', storage);
    expect(denied).toMatchObject({ status: 429, job: { snapshot: null, lease: null } });
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
  });

  it('requires explicit retry for a failed slot, preserves its ID, and never replans', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.render.mockRejectedValueOnce(new Error('Provider failed'));
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0].status).toBe('RETRY_REQUIRED');
    const continued = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(continued.job.slots.map(slot => slot.status)).toEqual(['RETRY_REQUIRED', 'SAVED']);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(mocks.render).toHaveBeenCalledTimes(2);
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
    const retried = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(retried.job.slots.every(slot => slot.status === 'SAVED')).toBe(true);
    expect(mocks.render.mock.calls[2][2].creativeId).toBe(job.slots[0].creativeId);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
  });

  it('recovers a saved image after a lost progress write before spending on another attempt', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const write = storage.write.bind(storage); let dropped = false;
    storage.write = async (key, bytes, etag) => {
      if (!dropped && key.startsWith('creative-portfolios/') && JSON.parse(bytes.toString()).slots[0].status === 'SAVED') {
        dropped = true; throw new Error('Lost progress checkpoint');
      }
      return write(key, bytes, etag);
    };
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const recovered = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(recovered.job.slots.every(slot => slot.status === 'SAVED')).toBe(true);
    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(records.map(record => record.id)).toEqual(job.slots.map(slot => slot.creativeId));
  });

  it('releases quota infrastructure failures without starting provider work', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    const write = storage.write.bind(storage);
    storage.write = async (key, bytes, etag) => {
      if (key.startsWith('quotas/')) throw new Error('Quota storage unavailable');
      return write(key, bytes, etag);
    };
    expect(await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage)).toMatchObject({ status: 503 });
    expect((await readCreativePortfolio(job.id, storage))?.lease).toBeNull();
    expect(mocks.prepareStep).not.toHaveBeenCalled();
  });
});
