import { randomUUID } from 'node:crypto';
import { prepareCreativeGeneration } from '@/lib/creatives/prepare-generation';
import { snapshotCreativePortfolio, restoreCreativePortfolio } from '@/lib/creatives/portfolio-snapshot';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { reconcilePortfolioResults } from '@/lib/creatives/portfolio-results';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { claimCreativePortfolio, finishPortfolioPlan, finishPortfolioSlot, failPortfolioWork, releasePortfolioWork,
  type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { CreativeGenerationPreparationError } from '@/lib/creatives/generation-sources';
import { GeneratedImageValidationError } from '@/lib/creatives/generated-image-validation';
import { reserveOperatorQuota, OperatorQuotaUnavailableError } from '@/lib/quotas/operator-quota';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

export type PortfolioStepResult = { job: CreativePortfolioJob; error?: string; status?: number; retryAfterSeconds?: number };

/** One whole-plan preparation OR one image; no background loop or automatic failed-provider retry. */
export async function advanceCreativePortfolio(
  id: string, operatorId: string, requestUrl: string, storage?: VideoIntelligenceStorage,
): Promise<PortfolioStepResult> {
  await reconcilePortfolioResults(id, storage);
  const token = randomUUID();
  const job = await updateCreativePortfolio(id, current => claimCreativePortfolio(current, Date.now(), token).job, storage);
  if (job.lease?.id !== token) return { job };
  const slotIndex = job.lease.slotIndex;
  const assertCurrentWork = async () => {
    const current = await readCreativePortfolio(id, storage);
    if (current?.lease?.id !== token || current.lease.expiresAtMs <= Date.now()) throw new Error('Portfolio work lease is no longer current.');
  };
  let providerWorkStarted = false;
  try {
    const quota = await reserveOperatorQuota({ operatorId,
      group: slotIndex === null ? 'CREATIVE_PLANNING' : 'CREATIVE_GENERATION',
      units: slotIndex === null ? job.request.variationCount : 1,
    }, { storage });
    if (!quota.allowed) return {
      job: await updateCreativePortfolio(id, current => releasePortfolioWork(current, token), storage),
      status: 429, error: 'Operator quota reached. Resume after the quota window resets.', retryAfterSeconds: quota.retryAfterSeconds,
    };
    await assertCurrentWork();
    providerWorkStarted = true;
    if (slotIndex === null) {
      const prepared = await prepareCreativeGeneration(job.request, requestUrl);
      const snapshot = snapshotCreativePortfolio(prepared);
      return { job: await updateCreativePortfolio(id, current => finishPortfolioPlan(current, token, snapshot), storage) };
    }
    const context = await restoreCreativePortfolio(job.snapshot!);
    const slot = job.slots[slotIndex - 1];
    const creative = await renderPlannedCreative(context.batchPlan.creatives[slotIndex - 1], context, {
      creativeId: slot.creativeId, assertCurrentWork,
    });
    return { job: await updateCreativePortfolio(id, current => finishPortfolioSlot(current, token, creative.id), storage) };
  } catch (error) {
    console.error('Portfolio work failed', error);
    const message = error instanceof CreativeGenerationPreparationError || error instanceof GeneratedImageValidationError
      ? error.message : 'Portfolio work could not be completed. Review its status before retrying.';
    const current = await updateCreativePortfolio(id, value => {
      if (value.lease?.id !== token) return value; // Another worker's progress is authoritative.
      if (value.lease.expiresAtMs <= Date.now()) return claimCreativePortfolio(value).job;
      return providerWorkStarted ? failPortfolioWork(value, token, message) : releasePortfolioWork(value, token);
    }, storage);
    return { job: current, error: message, status: error instanceof OperatorQuotaUnavailableError ? 503
      : error instanceof CreativeGenerationPreparationError ? error.status : 500 };
  }
}
