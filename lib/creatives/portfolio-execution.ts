import { randomUUID } from 'node:crypto';
import { auditCreativePortfolio } from '@/lib/ai/portfolio-auditor';
import { creativeRepairFeedback, requestCreativeBatch } from '@/lib/ai/creative-planner';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import { advancePortfolioPreparation } from '@/lib/creatives/portfolio-preparation';
import { snapshotCreativePortfolio, restoreCreativePortfolio } from '@/lib/creatives/portfolio-snapshot';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { reconcilePortfolioResults } from '@/lib/creatives/portfolio-results';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { claimCreativePortfolio, finishPortfolioAuditFailure, finishPortfolioAuditForRepair, finishPortfolioInitialPlan,
  finishPortfolioPlan, finishPortfolioPreparation, finishPortfolioRepair, finishPortfolioSlot, failPortfolioWork, releasePortfolioWork,
  type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { CreativeGenerationPreparationError } from '@/lib/creatives/generation-sources';
import { GeneratedImageValidationError } from '@/lib/creatives/generated-image-validation';
import { reserveOperatorQuota, OperatorQuotaUnavailableError } from '@/lib/quotas/operator-quota';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

export type PortfolioStepResult = { job: CreativePortfolioJob; error?: string; status?: number; retryAfterSeconds?: number };

/** One persisted provider-capable planning step OR one image; no background loop or automatic failed-provider retry. */
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
    if (slotIndex === null && job.planning.phase === 'INITIAL_PLAN' && !job.planning.preparation.quotaReserved) {
      const quota = await reserveOperatorQuota({
        operatorId,
        group: 'CREATIVE_PLANNING',
        units: job.request.variationCount,
      }, { storage });
      if (!quota.allowed) return {
        job: await updateCreativePortfolio(id, current => releasePortfolioWork(current, token), storage),
        status: 429,
        error: 'Operator quota reached. Resume after the quota window resets.',
        retryAfterSeconds: quota.retryAfterSeconds,
      };
      const preparation = { ...job.planning.preparation, quotaReserved: true };
      return { job: await updateCreativePortfolio(id, current => finishPortfolioPreparation(current, token, preparation), storage) };
    }

    if (slotIndex !== null) {
      const quota = await reserveOperatorQuota({ operatorId, group: 'CREATIVE_GENERATION', units: 1 }, { storage });
      if (!quota.allowed) return {
        job: await updateCreativePortfolio(id, current => releasePortfolioWork(current, token), storage),
        status: 429,
        error: 'Operator quota reached. Resume after the quota window resets.',
        retryAfterSeconds: quota.retryAfterSeconds,
      };
    }

    await assertCurrentWork();
    if (slotIndex === null) {
      if (job.planning.phase === 'INITIAL_PLAN') {
        const result = await advancePortfolioPreparation(
          job.request,
          requestUrl,
          job.planning.preparation,
          () => { providerWorkStarted = true; },
        );
        if (result.state) {
          return { job: await updateCreativePortfolio(id, current => finishPortfolioPreparation(current, token, result.state), storage) };
        }
        const prepared = result.prepared;
        if (!prepared.plannerArgs) throw new Error('Creative planning context was not preserved.');
        const checkpoint = { snapshot: snapshotCreativePortfolio(prepared), plannerArgs: structuredClone(prepared.plannerArgs) };
        return { job: await updateCreativePortfolio(id, current => finishPortfolioInitialPlan(current, token, checkpoint), storage) };
      }
      providerWorkStarted = true;
      if (job.planning.phase === 'DIVERSITY_AUDIT') {
        const { checkpoint, repairAttempted } = job.planning;
        const audit = await auditCreativePortfolio(checkpoint.snapshot.batchPlan.creatives);
        const issue = getCreativeDiversityIssue(checkpoint.snapshot.batchPlan.creatives, audit);
        if (!issue) {
          const snapshot = structuredClone(checkpoint.snapshot);
          snapshot.batchPlan.portfolioAudit = audit;
          return { job: await updateCreativePortfolio(id, current => finishPortfolioPlan(current, token, snapshot), storage) };
        }
        if (!repairAttempted) {
          return { job: await updateCreativePortfolio(id, current => finishPortfolioAuditForRepair(current, token, audit), storage) };
        }
        const message = `Portfolio remains insufficiently distinct after one planning repair: ${issue}. No images were generated.`;
        return { job: await updateCreativePortfolio(id, current => finishPortfolioAuditFailure(current, token, audit, message), storage),
          error: message, status: 502 };
      }
      if (job.planning.phase === 'TARGETED_REPAIR') {
        const { checkpoint } = job.planning;
        const audit = checkpoint.snapshot.batchPlan.portfolioAudit!;
        const issue = getCreativeDiversityIssue(checkpoint.snapshot.batchPlan.creatives, audit);
        if (!issue) throw new Error('Portfolio repair was requested without a diversity issue.');
        const batchPlan = await requestCreativeBatch({ ...checkpoint.plannerArgs,
          context: checkpoint.plannerArgs.context + creativeRepairFeedback(issue, audit) });
        return { job: await updateCreativePortfolio(id, current => finishPortfolioRepair(current, token, batchPlan), storage) };
      }
      throw new Error('Portfolio planning phase is not executable.');
    }

    providerWorkStarted = true;
    const context = await restoreCreativePortfolio(job.snapshot!);
    const slot = job.slots[slotIndex - 1];
    const creative = await renderPlannedCreative(context.batchPlan.creatives[slotIndex - 1], context, {
      creativeId: slot.creativeId,
      assertCurrentWork,
    });
    return { job: await updateCreativePortfolio(id, current => finishPortfolioSlot(current, token, creative.id), storage) };
  } catch (error) {
    console.error('Portfolio work failed', error);
    const message = error instanceof CreativeGenerationPreparationError || error instanceof GeneratedImageValidationError
      ? error.message : 'Portfolio work could not be completed. Review its status before retrying.';
    const current = await updateCreativePortfolio(id, value => {
      if (value.lease?.id !== token) return value;
      if (value.lease.expiresAtMs <= Date.now()) return claimCreativePortfolio(value).job;
      return providerWorkStarted ? failPortfolioWork(value, token, message) : releasePortfolioWork(value, token);
    }, storage);
    return { job: current, error: message, status: error instanceof OperatorQuotaUnavailableError ? 503
      : error instanceof CreativeGenerationPreparationError ? error.status : 500 };
  }
}
