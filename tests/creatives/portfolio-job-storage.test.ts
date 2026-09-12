import { describe, expect, it } from 'vitest';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { claimCreativePortfolio, finishPortfolioAuditForRepair, finishPortfolioRepair, finishPortfolioInitialPlan, finishPortfolioPlan, finishPortfolioPreparation, finishPortfolioSlot,
  newCreativePortfolio, retryPortfolioWork, PORTFOLIO_LEASE_MS, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { portfolioAudit } from '../fixtures/portfolio-audit';
import { MemoryPortfolioStorage as MemoryStorage, portfolioRequest as request, portfolioSnapshot as snapshot } from '../fixtures/creative-portfolio';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('durable creative portfolio storage', () => {
  it('creates an explicitly legacy portfolio without enabling composed preparation', async () => {
    const storage = new MemoryStorage(), job = await createCreativePortfolio(request(), storage, 1000);
    expect(job.sourceCompositionVersion).toBe(1);
    expect(job.planning).toEqual({ phase: 'INITIAL_PLAN', preparation: { quotaReserved: false } });
    expect(await readCreativePortfolio(job.id, storage)).toEqual(job);
  });

  it.each([0, 2, -1, 1.5, '1', null, {}, []])('rejects unsupported composition marker %j without rewriting saved data', async marker => {
    const storage = new MemoryStorage(), job = newCreativePortfolio(request(), 1000);
    const key = `creative-portfolios/v1/${job.id}.json`, original = encode({ ...job, sourceCompositionVersion: marker });
    await storage.write(key, original, null);
    await expect(readCreativePortfolio(job.id, storage)).rejects.toThrow('Unsupported portfolio source composition version');
    expect((await storage.read(key))?.bytes).toEqual(original);
  });

  it.each([undefined, 1] as const)('preserves composition marker %s and completed work through resume and explicit retry', async marker => {
    const { sourceCompositionVersion: _version, ...historical } = newCreativePortfolio(request(), 1000);
    const job: CreativePortfolioJob = { ...historical, ...(marker === undefined ? {} : { sourceCompositionVersion: marker }) };
    const analysis = { summary: 'Saved video analysis', visibleText: [], visualStructure: '', hookOrAngle: '', offerOrCta: '',
      styleNotes: '', preserve: ['Saved cue'], avoid: [], unknowns: [], dominantCategory: 'customer-problems' as const };
    job.planning = { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, analysis } };
    const leased = claimCreativePortfolio(job, 2000, 'unfinished').job;
    const storage = new MemoryStorage(), key = `creative-portfolios/v1/${job.id}.json`, original = encode(leased);
    await storage.write(key, original, null);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(leased);
    expect((await storage.read(key))?.bytes).toEqual(original);
    expect(claimCreativePortfolio(leased, 3000).status).toBe('BUSY');
    const now = 2000 + PORTFOLIO_LEASE_MS;
    const expired = await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, now).job, storage);
    expect(expired.planning).toEqual(job.planning);
    expect(expired.planningError).toContain('uncertain');
    expect(claimCreativePortfolio(expired, now + 1).status).toBe('RETRY_REQUIRED');
    const retried = await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null, now + 2), storage);
    expect(retried.planning).toEqual(job.planning);
    expect(retried.slots).toEqual(job.slots);
    const planned = snapshot(job);
    planned.videoFrames = [{ timestampMs: 1200, sha256: 'a'.repeat(64) }];
    const { portfolioAudit: _audit, ...batchPlan } = planned.batchPlan;
    const checkpoint = { snapshot: { ...planned, batchPlan }, plannerArgs: {
      count: job.slots.length, context: job.request.context, analysis, hasApprovedHumanSource: false, referenceCatalog: [],
    } };
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, now + 3, 'plan').job, storage);
    const initial = await updateCreativePortfolio(job.id, current => finishPortfolioInitialPlan(current, 'plan', checkpoint, now + 4), storage);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(initial);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, now + 5, 'audit').job, storage);
    const repeated = { ...portfolioAudit(2), groups: [{ conceptIndexes: [1, 2], proposition: 'Same', distinction: 'Repeated' }] };
    const repair = await updateCreativePortfolio(job.id, current => finishPortfolioAuditForRepair(current, 'audit', repeated, now + 6), storage);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(repair);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, now + 7, 'repair').job, storage);
    await updateCreativePortfolio(job.id, current => finishPortfolioRepair(current, 'repair', batchPlan, now + 8), storage);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, now + 9, 'final-audit').job, storage);
    await updateCreativePortfolio(job.id, current => finishPortfolioPlan(current, 'final-audit', planned, now + 10), storage);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, now + 11, 'render').job, storage);
    const saved = await updateCreativePortfolio(job.id, current => finishPortfolioSlot(current, 'render', current.slots[0].creativeId, now + 12), storage);
    expect(saved.snapshot).toEqual(planned);
    expect(saved.slots[0]).toEqual({ ...job.slots[0], status: 'SAVED' });
    expect(saved.slots[1]).toEqual(job.slots[1]);
    expect(saved.request).toEqual(job.request);
    expect(saved.sourceCompositionVersion).toBe(marker);
    if (marker === undefined) expect(saved).not.toHaveProperty('sourceCompositionVersion');
    expect(await readCreativePortfolio(job.id, storage)).toEqual(saved);
    const beforeMutation = (await storage.read(key))!.bytes;
    for (const replacement of [undefined, 1, 2].filter(value => value !== marker)) {
      await expect(updateCreativePortfolio(job.id, current => ({ ...current, sourceCompositionVersion: replacement } as CreativePortfolioJob), storage))
        .rejects.toThrow('source composition version is immutable');
      expect((await storage.read(key))!.bytes).toEqual(beforeMutation);
    }
  });

  it('reopens all 36 reserved identities and the complete audited snapshot without wrapping Company context again', async () => {
    const storage = new MemoryStorage(), job = await createCreativePortfolio(request(36), storage, 1000);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000, 'plan').job, storage);
    const saved = await updateCreativePortfolio(job.id, current => finishPortfolioPlan(current, 'plan', snapshot(current), 3000), storage);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(saved);
    expect(saved.request.context).toBe(request().context);
    expect(saved.slots).toEqual(job.slots);
    expect(saved.snapshot?.batchPlan.creatives).toHaveLength(36);
  });
  it('serializes simultaneous claims so only one caller owns the current lease', async () => {
    const storage = new MemoryStorage(), job = await createCreativePortfolio(request(), storage, 1000);
    const claims = await Promise.all(['first', 'second'].map(token => updateCreativePortfolio(job.id,
      current => claimCreativePortfolio(current, 2000, token).job, storage)));
    expect(new Set(claims.map(claim => claim.lease?.id)).size).toBe(1);
    await expect(updateCreativePortfolio(job.id, current => finishPortfolioPlan(current, 'stale', snapshot(current), 3000), storage)).rejects.toThrow('lease');
  });
  it('preserves successful outputs, the plan and reserved IDs across competing progress updates', async () => {
    const storage = new MemoryStorage(), job = await createCreativePortfolio(request(), storage, 1000);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000, 'plan').job, storage);
    await updateCreativePortfolio(job.id, current => finishPortfolioPlan(current, 'plan', snapshot(current), 3000), storage);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 4000, 'render').job, storage);
    await updateCreativePortfolio(job.id, current => finishPortfolioSlot(current, 'render', current.slots[0].creativeId, 5000), storage);
    for (const change of [
      (current: CreativePortfolioJob) => ({ ...current, request: { ...current.request, context: 'Changed' } }),
      (current: CreativePortfolioJob) => ({ ...current, snapshot: null }),
      (current: CreativePortfolioJob) => ({ ...current, slots: current.slots.map(slot => ({ ...slot, status: 'PENDING' as const })) }),
      (current: CreativePortfolioJob) => ({ ...current, slots: [...current.slots].reverse() }),
    ]) await expect(updateCreativePortfolio(job.id, change, storage)).rejects.toThrow('may not replace');
    expect((await readCreativePortfolio(job.id, storage))?.slots[0].status).toBe('SAVED');
  });
  it('persists uncertainty and only permits the explicit retry transition after lease expiry', async () => {
    const storage = new MemoryStorage(), job = await createCreativePortfolio(request(), storage, 1000);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000, 'plan').job, storage);
    const expired = await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000 + PORTFOLIO_LEASE_MS).job, storage);
    expect((await readCreativePortfolio(job.id, storage))?.planningError).toContain('uncertain');
    const retried = await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null, 3000 + PORTFOLIO_LEASE_MS), storage);
    expect(retried.slots).toEqual(expired.slots);
    expect(retried.planningError).toBeUndefined();
  });
  it('accepts provider-valid empty analysis strings in resumable checkpoints', async () => {
    const storage = new MemoryStorage(), job = await createCreativePortfolio(request(), storage, 1000);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000, 'quota').job, storage);
    await updateCreativePortfolio(job.id, current => finishPortfolioPreparation(current, 'quota', { quotaReserved: true }, 2500), storage);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 3000, 'plan').job, storage);
    const planned = snapshot(job);
    const { portfolioAudit: _audit, ...batchPlan } = planned.batchPlan;
    const checkpoint = {
      snapshot: { ...planned, batchPlan },
      plannerArgs: {
        count: job.slots.length,
        context: 'Prepared context',
        analysis: { summary: '', visibleText: [], visualStructure: '', hookOrAngle: '', offerOrCta: '', styleNotes: '',
          preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems' as const },
        hasApprovedHumanSource: false,
        referenceCatalog: planned.referenceCatalog,
      },
    };
    const saved = await updateCreativePortfolio(job.id, current => finishPortfolioInitialPlan(current, 'plan', checkpoint, 3500), storage);
    expect(saved.planning.phase).toBe('DIVERSITY_AUDIT');
    expect(await readCreativePortfolio(job.id, storage)).toEqual(saved);
  });
  it('fails closed on malformed selected-reference preparation checkpoints', () => {
    const job = { ...newCreativePortfolio(request(), 1000),
      planning: { phase: 'INITIAL_PLAN' as const, preparation: { quotaReserved: true, selectedReferences: [null] } } };
    expect(() => parseCreativePortfolioJob(encode(job), job.id)).toThrow('invalid');
  });
  it('fails closed on corrupted state, invalid IDs and incomplete saved audits', async () => {
    const storage = new MemoryStorage(), job = await createCreativePortfolio(request(), storage, 1000);
    for (const value of [{}, { ...job, slots: [] }, { ...job, lease: { id: 'x', slotIndex: 1, expiresAtMs: 5000 } },
      { ...job, snapshot: { ...snapshot(job), batchPlan: { ...snapshot(job).batchPlan, portfolioAudit: portfolioAudit(3) } } }]) {
      expect(() => parseCreativePortfolioJob(encode(value), job.id)).toThrow('invalid');
    }
    await expect(readCreativePortfolio('../other', storage)).rejects.toThrow('Invalid');
    expect(await readCreativePortfolio('portfolio_' + 'a'.repeat(32), storage)).toBeNull();
    storage.data.values().next().value!.bytes = Buffer.from('{');
    await expect(readCreativePortfolio(job.id, storage)).rejects.toThrow('invalid');
  });
});
