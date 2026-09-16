import { describe, expect, it } from 'vitest';
import { claimCreativePortfolio, finishPortfolioInitialPlan } from '@/lib/creatives/portfolio-job';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

const analysis = {
  summary: 'Saved analysis', visibleText: [], visualStructure: '', hookOrAngle: '', offerOrCta: '', styleNotes: '',
  preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems' as const,
};
const approvedHumanOptions = Array.from({ length: 10 }, (_, index) => ({
  id: `human_${(index + 1).toString(16).padStart(64, '0')}`,
  sourceName: `TRA source ${index + 1}`,
  description: `Approved presenter ${index + 1}`,
}));

describe('approved-human planner checkpoint persistence', () => {
  it('saves and reloads more than eight valid approved-human options without truncation', async () => {
    const storage = new MemoryPortfolioStorage();
    const job = await createCreativePortfolio(portfolioRequest(), storage, 1000);
    await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, 2000, 'plan').job, storage);
    const planned = portfolioSnapshot(job);
    const { portfolioAudit: _audit, ...batchPlan } = planned.batchPlan;
    const checkpoint = {
      snapshot: { ...planned, batchPlan },
      plannerArgs: {
        count: job.slots.length,
        context: job.request.context,
        analysis,
        hasApprovedHumanSource: false,
        referenceCatalog: [],
        approvedHumanOptions,
      },
    };

    const saved = await updateCreativePortfolio(
      job.id,
      current => finishPortfolioInitialPlan(current, 'plan', checkpoint, 3000),
      storage,
    );
    const reloaded = await readCreativePortfolio(job.id, storage);

    expect(reloaded).toEqual(saved);
    expect(reloaded?.planning.phase).toBe('DIVERSITY_AUDIT');
    if (reloaded?.planning.phase !== 'DIVERSITY_AUDIT') throw new Error('Expected saved planner checkpoint.');
    expect(reloaded.planning.checkpoint.plannerArgs.approvedHumanOptions).toEqual(approvedHumanOptions);
    expect(reloaded.planning.checkpoint.plannerArgs.approvedHumanOptions).toHaveLength(10);
  });
});
