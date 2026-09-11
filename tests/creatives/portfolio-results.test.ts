import { beforeEach, describe, expect, it, vi } from 'vitest';
import { portfolioSavedCreatives, reconcilePortfolioResults } from '@/lib/creatives/portfolio-results';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { claimCreativePortfolio, finishPortfolioPlan, retryPortfolioWork, PORTFOLIO_LEASE_MS, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

const list = vi.hoisted(() => vi.fn());
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: list }));
const savedRecord = (job: CreativePortfolioJob): CreativeRecord => {
  const concept = job.snapshot!.batchPlan.creatives[0], id = job.slots[0].creativeId;
  return { id, createdAt: '2026-09-11T00:00:00.000Z', category: concept.strategy.category, format: concept.format,
    placement: job.request.placement, copy: concept.copy, identity: buildCreativeIdentity({ creativeId: id, operation: 'GENERATE', strategy: concept.strategy }),
    image: { id: 'media_' + 'a'.repeat(32), fileName: 'saved.png', originalName: 'saved.png', mimeType: 'image/png', size: 100, url: '/api/media/files/saved.png' } };
};
const ready = async (storage: MemoryPortfolioStorage) => {
  const job = await createCreativePortfolio(portfolioRequest(), storage, 1000);
  await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000, 'plan').job, storage);
  return updateCreativePortfolio(job.id, current => finishPortfolioPlan(current, 'plan', portfolioSnapshot(current), 3000), storage);
};

describe('saved portfolio result reconciliation', () => {
  beforeEach(() => { list.mockReset().mockResolvedValue([]); });
  it('recovers a saved result after a lost checkpoint and skips it on the next work claim', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage), record = savedRecord(job);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 4000, 'lost').job, storage);
    list.mockResolvedValue([record]);
    const recovered = await reconcilePortfolioResults(job.id, storage, 4000 + PORTFOLIO_LEASE_MS);
    expect(recovered.lease).toBeNull();
    expect(recovered.slots[0].status).toBe('SAVED');
    expect(claimCreativePortfolio(recovered, 5000 + PORTFOLIO_LEASE_MS).job.lease?.slotIndex).toBe(2);
    expect(() => retryPortfolioWork(recovered, 1)).toThrow('does not require');
    expect(portfolioSavedCreatives(recovered, [record])[0]).toMatchObject({
      id: record.id, index: 1, image: record.image, finalization: { status: 'SAVED', createdAt: record.createdAt },
    });
  });
  it('does not steal an active worker lease or fabricate success when a record is missing', async () => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage);
    const leased = await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 4000, 'active').job, storage);
    list.mockResolvedValue([savedRecord(job)]);
    expect(await reconcilePortfolioResults(job.id, storage, 4500)).toEqual(leased);
    list.mockResolvedValue([]);
    const uncertain = await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 4000 + PORTFOLIO_LEASE_MS).job, storage);
    expect(await reconcilePortfolioResults(job.id, storage, 5000 + PORTFOLIO_LEASE_MS)).toEqual(uncertain);
    expect(uncertain.slots[0].status).toBe('RETRY_REQUIRED');
  });
  it.each(['identity', 'copy', 'format', 'placement'] as const)('rejects a mismatched saved %s without changing progress', async field => {
    const storage = new MemoryPortfolioStorage(), job = await ready(storage);
    list.mockResolvedValue([{ ...savedRecord(job), [field]: null }]);
    await expect(reconcilePortfolioResults(job.id, storage, 4000)).rejects.toThrow('does not match');
    expect(await readCreativePortfolio(job.id, storage)).toEqual(job);
  });
});
