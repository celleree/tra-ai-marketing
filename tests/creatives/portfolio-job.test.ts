import { describe, expect, it } from 'vitest';
import { newCreativePortfolio, claimCreativePortfolio, finishPortfolioPlan, finishPortfolioSlot, failPortfolioWork,
  releasePortfolioWork, retryPortfolioWork, PORTFOLIO_LEASE_MS } from '@/lib/creatives/portfolio-job';
import type { CreativePortfolioSnapshot } from '@/lib/creatives/portfolio-snapshot';

const initial = (count = 2) => newCreativePortfolio({
  context: 'Frozen Company context', sourceAssets: [], placement: 'SQUARE_1_1', variationCount: count,
}, 1000);
const planned = () => {
  const claim = claimCreativePortfolio(initial(), 2000, 'planning');
  const snapshot = { version: 1, request: claim.job.request,
    batchPlan: { creatives: claim.job.slots.map(slot => ({ index: slot.index })) } } as CreativePortfolioSnapshot;
  return finishPortfolioPlan(claim.job, 'planning', snapshot, 3000);
};

describe('creative portfolio job transitions', () => {
  it('reserves 36 persistent creative identities before planning or rendering', () => {
    const job = initial(36);
    expect(job.id).toMatch(/^portfolio_[a-f0-9]{32}$/);
    expect(new Set(job.slots.map(slot => slot.creativeId)).size).toBe(36);
    expect(job.slots.every(slot => /^creative_[a-f0-9]{32}$/.test(slot.creativeId))).toBe(true);
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
    expect(() => initial(37)).toThrow('2 to 36');
  });

  it('allows only one active lease and requires explicit retry after interrupted planning', () => {
    const first = claimCreativePortfolio(initial(), 2000, 'one');
    expect(first.status).toBe('WORK');
    expect(claimCreativePortfolio(first.job, 2001).status).toBe('BUSY');
    const expired = claimCreativePortfolio(first.job, 2000 + PORTFOLIO_LEASE_MS);
    expect(expired.status).toBe('RETRY_REQUIRED');
    expect(claimCreativePortfolio(expired.job).status).toBe('RETRY_REQUIRED');
    const retried = retryPortfolioWork(expired.job, null);
    expect(claimCreativePortfolio(retried).status).toBe('WORK');
    expect(retried.slots).toEqual(first.job.slots);
  });

  it('rejects stale leases and plans with missing, reordered or different-request slots', () => {
    const claim = claimCreativePortfolio(initial(), 2000, 'plan').job;
    const snapshot = planned().snapshot!;
    expect(() => finishPortfolioPlan(claim, 'other', snapshot, 3000)).toThrow('lease');
    expect(() => finishPortfolioPlan(claim, 'plan', snapshot, 2000 + PORTFOLIO_LEASE_MS)).toThrow('lease');
    for (const changed of [
      { ...snapshot, request: { ...snapshot.request, context: 'Changed' } },
      { ...snapshot, batchPlan: { ...snapshot.batchPlan, creatives: [] } },
      { ...snapshot, batchPlan: { ...snapshot.batchPlan, creatives: [...snapshot.batchPlan.creatives].reverse() } },
    ]) expect(() => finishPortfolioPlan(claim, 'plan', changed, 3000)).toThrow('reserved slots');
  });

  it('preserves the saved plan and successful slots across failed render/retry', () => {
    const plan = planned();
    const first = claimCreativePortfolio(plan, 4000, 'render1').job;
    expect(() => finishPortfolioSlot(first, 'render1', plan.slots[1].creativeId, 4500)).toThrow('reserved creative');
    const saved = finishPortfolioSlot(first, 'render1', plan.slots[0].creativeId, 5000);
    const second = claimCreativePortfolio(saved, 6000, 'render2').job;
    const failed = failPortfolioWork(second, 'render2', 'Provider response missing', 7000);
    expect(claimCreativePortfolio(failed, 8000).status).toBe('RETRY_REQUIRED');
    expect(() => retryPortfolioWork(failed, 1, 9000)).toThrow('does not require');
    expect(() => retryPortfolioWork(failed, null, 9000)).toThrow('does not require');
    const retried = retryPortfolioWork(failed, 2, 9000);
    expect(retried.snapshot).toEqual(plan.snapshot);
    expect(retried.slots[0]).toEqual(saved.slots[0]);
    const final = claimCreativePortfolio(retried, 10000, 'render3').job;
    expect(claimCreativePortfolio(finishPortfolioSlot(final, 'render3', final.slots[1].creativeId, 11000), 12000).status).toBe('COMPLETE');
  });

  it('marks an expired image attempt uncertain while allowing other pending slots to continue', () => {
    const first = claimCreativePortfolio(planned(), 4000, 'render').job;
    const expired = claimCreativePortfolio(first, 4000 + PORTFOLIO_LEASE_MS);
    expect(expired.job.slots[0].status).toBe('RETRY_REQUIRED');
    expect(expired.job.slots[0].error).toContain('uncertain');
    const next = claimCreativePortfolio(expired.job, 5000 + PORTFOLIO_LEASE_MS, 'next');
    expect(next.job.lease?.slotIndex).toBe(2);
    expect(() => retryPortfolioWork(next.job, 1)).toThrow('still leased');
  });

  it('releases a pre-provider denial without making a successful slot retryable', () => {
    const claim = claimCreativePortfolio(planned(), 4000, 'quota').job;
    const released = releasePortfolioWork(claim, 'quota', 5000);
    expect(released.slots).toEqual(claim.slots);
    expect(claimCreativePortfolio(released, 6000).job.lease?.slotIndex).toBe(1);
  });
});
