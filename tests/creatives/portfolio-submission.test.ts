import { describe, expect, it } from 'vitest';
import { createCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { parseSubmissionId } from '@/lib/creatives/submission-id';
import { MemoryPortfolioStorage, portfolioRequest } from '../fixtures/creative-portfolio';

const submission = { operatorId: 'operator-a', id: '11111111-1111-4111-8111-111111111111' };
describe('portfolio submission identity', () => {
  it('concurrent repeated delivery returns one job and identical creative IDs', async () => {
    const storage = new MemoryPortfolioStorage();
    const jobs = await Promise.all(Array.from({ length: 8 }, () => createCreativePortfolio(portfolioRequest(), storage, 1, submission)));
    expect(new Set(jobs.map(job => job.id)).size).toBe(1);
    expect(new Set(jobs.map(job => JSON.stringify(job.slots))).size).toBe(1);
    expect(storage.data.size).toBe(1);
    await updateCreativePortfolio(jobs[0].id, job => ({ ...job, updatedAtMs: 2, planningError: 'Saved failure' }), storage);
    expect((await createCreativePortfolio(portfolioRequest(), storage, 3, submission)).planningError).toBe('Saved failure');
  });
  it('rejects changed input for an existing identity and permits deliberate new work', async () => {
    const storage = new MemoryPortfolioStorage(); const first = await createCreativePortfolio(portfolioRequest(), storage, 1, submission);
    await expect(createCreativePortfolio({ ...portfolioRequest(), context: 'Changed' }, storage, 2, submission)).rejects.toThrow('inputs changed');
    const next = await createCreativePortfolio(portfolioRequest(), storage, 2, { ...submission, id: crypto.randomUUID() });
    const other = await createCreativePortfolio(portfolioRequest(), storage, 2, { ...submission, operatorId: 'operator-b' });
    expect(new Set([first.id, next.id, other.id]).size).toBe(3);
  });
  it('fails closed for malformed identities and lost write acknowledgement recovers the same job', async () => {
    const storage = new MemoryPortfolioStorage(); const write = storage.write.bind(storage);
    await expect(createCreativePortfolio(portfolioRequest(), storage, 1, { ...submission, id: 'bad' })).rejects.toThrow('identity');
    expect(parseSubmissionId(null)).toBeNull(); expect(parseSubmissionId('not-a-uuid')).toBeNull();
    storage.write = async (...args) => { await write(...args); throw new Error('Lost acknowledgement'); };
    await expect(createCreativePortfolio(portfolioRequest(), storage, 1, submission)).rejects.toThrow('Lost acknowledgement');
    storage.write = write;
    const replay = await createCreativePortfolio(portfolioRequest(), storage, 2, submission);
    expect(replay.createdAtMs).toBe(1); expect(storage.data.size).toBe(1);
  });
});
