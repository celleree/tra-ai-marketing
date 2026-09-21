import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { auditCreativePortfolio } from '@/lib/ai/portfolio-auditor';
import { requestCreativeBatch } from '@/lib/ai/creative-planner';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import { advancePortfolioPreparation } from '@/lib/creatives/portfolio-preparation';
import { advancePlanningSourceAnalysis } from '@/lib/creatives/planning-source-composition';
import { stepPortfolioVideoDependency } from '@/lib/creatives/portfolio-video-adapter';
import { hydratePortfolioVideoFrameSelection, selectPortfolioVideoFrames } from '@/lib/creatives/portfolio-video-selection';
import { projectCompletedVideoIntelligence } from '@/lib/creatives/video-intelligence-planning';
import { snapshotCreativePortfolio, restoreCreativePortfolio } from '@/lib/creatives/portfolio-snapshot';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { classifyCreativeCopyContract } from '@/lib/creatives/copy-contract';
import { reconcilePortfolioResults } from '@/lib/creatives/portfolio-results';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { checkpointPortfolioPreparation, checkpointPortfolioVideoSelectionAttempt, claimCreativePortfolio,
  finishPortfolioAuditFailure, finishPortfolioAuditForRepair, finishPortfolioInitialPlan, finishPortfolioPlan,
  finishPortfolioPreparation, finishPortfolioPreparationFailure, finishPortfolioRepair, finishPortfolioSlot,
  finishPortfolioVideoFrameSelection, failPortfolioWork, releasePortfolioWork,
  type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { CreativeGenerationPreparationError, hydratePlanningSourceInventory } from '@/lib/creatives/generation-sources';
import { GeneratedImageValidationError } from '@/lib/creatives/generated-image-validation';
import { reserveOperatorQuota, OperatorQuotaUnavailableError } from '@/lib/quotas/operator-quota';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import type { VideoIntelligenceServiceDependencies } from '@/lib/video/intelligence-service';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { VideoRetryStateChangedError } from '@/lib/video/intelligence-job-store';

export type PortfolioStepResult = { job: CreativePortfolioJob; error?: string; status?: number; retryAfterSeconds?: number };

class InvalidPlannedCreativeCopyError extends CreativeGenerationPreparationError {}

const assertValidPlannedCreativeCopy = (concept: Parameters<typeof classifyCreativeCopyContract>[0]) => {
  if (classifyCreativeCopyContract(concept).kind === 'INVALID') {
    throw new InvalidPlannedCreativeCopyError(
      'Creative plan has an invalid separated ad/image copy contract and cannot be rendered.',
      409,
    );
  }
};

/** One persisted provider-capable planning step OR one image; no background loop or automatic failed-provider retry. */
export async function advanceCreativePortfolio(
  id: string, operatorId: string, requestUrl: string, storage?: VideoIntelligenceStorage,
  options: { deadlineAtMs?: number; video?: Omit<VideoIntelligenceServiceDependencies, 'storage' | 'deadlineAtMs'> } = {},
): Promise<PortfolioStepResult> {
  const deadlineAtMs = options.deadlineAtMs ?? Date.now() + 290_000;
  await reconcilePortfolioResults(id, storage);
  const token = randomUUID();
  const job = await updateCreativePortfolio(id, current => claimCreativePortfolio(current, Date.now(), token).job, storage);
  if (job.lease?.id !== token) return { job };
  const slotIndex = job.lease.slotIndex;
  const assertCurrentWork = async () => {
    const current = await readCreativePortfolio(id, storage);
    if (current?.lease?.id !== token || current.lease.expiresAtMs <= Date.now()) throw new Error('Portfolio work lease is no longer current.');
  };
  const reserveWorkQuota = async (group: 'VIDEO_SELECTION' | 'CREATIVE_GENERATION') => {
    const quota = await reserveOperatorQuota({ operatorId, group, units: 1 }, { storage });
    if (quota.allowed) return null;
    return {
      job: await updateCreativePortfolio(id, current => releasePortfolioWork(current, token), storage),
      status: 429,
      error: 'Operator quota reached. Resume after the quota window resets.',
      retryAfterSeconds: quota.retryAfterSeconds,
    } satisfies PortfolioStepResult;
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

    await assertCurrentWork();
    if (slotIndex === null) {
      if (job.planning.phase === 'INITIAL_PLAN') {
        if (job.videoPreparationVersion === 1) {
          const state = structuredClone(job.planning.preparation);
          const videos = job.request.sourceAssets.filter(source => source.role === 'TRA_VIDEO');
          const projected = state.sourceAnalysis?.entries.filter(entry => entry.source.role === 'TRA_VIDEO') ?? [];
          const projectionComplete = projected.length === videos.length
            && projected.every(entry => entry.result?.kind === 'VIDEO_INTELLIGENCE');
          if (!projectionComplete) {
            const pending = videos.find(source => !state.videoDependencies?.find(dependency =>
              dependency.identity.sourceVideoMediaId === source.mediaId)?.completed);
            if (pending) {
              const dependency = state.videoDependencies?.find(item => item.identity.sourceVideoMediaId === pending.mediaId);
              const authorization = state.videoRetryAuthorization;
              const owner = {
                operatorId,
                assertLease: assertCurrentWork,
                checkpoint: async (saved: NonNullable<typeof dependency>) => {
                  state.videoDependencies = [...(state.videoDependencies ?? []).filter(item =>
                    item.identity.sourceVideoMediaId !== pending.mediaId), saved];
                  await updateCreativePortfolio(id, current => checkpointPortfolioPreparation(current, token, state), storage);
                },
                onProviderOperationStart: () => { providerWorkStarted = true; },
              };
              const action = authorization
                ? { action: 'RETRY' as const, retryAuthorization: authorization, ...owner,
                    consumeRetryAuthorization: async (expected: typeof authorization) => {
                      if (!isDeepStrictEqual(expected, state.videoRetryAuthorization)) throw new Error('Video Retry authorization changed.');
                      delete state.videoRetryAuthorization;
                      await updateCreativePortfolio(id, current => checkpointPortfolioPreparation(current, token, state), storage);
                    } }
                : { action: 'ADVANCE' as const, ...owner };
              const service = { ...options.video, storage, deadlineAtMs };
              let stepped: Awaited<ReturnType<typeof stepPortfolioVideoDependency>>;
              try {
                stepped = await stepPortfolioVideoDependency({ mediaId: pending.mediaId, dependency, ...action }, service);
              } catch (error) {
                if (!authorization || !(error instanceof VideoRetryStateChangedError)) throw error;
                // The authorized child revision changed before RETRY. Refresh read-only and require another explicit Retry.
                delete state.videoRetryAuthorization;
                stepped = await stepPortfolioVideoDependency({ mediaId: pending.mediaId, dependency, action: 'STATUS' }, service);
              }
              state.videoDependencies = [...(state.videoDependencies ?? []).filter(item =>
                item.identity.sourceVideoMediaId !== pending.mediaId), stepped.dependency];
              const status = stepped.status;
              state.videoProgress = status ? { mediaId: pending.mediaId, phase: status.phase, busy: status.busy,
                completedRepresentatives: status.completedRepresentatives, totalRepresentatives: status.totalRepresentatives,
                ...(stepped.retryAuthorization ? { retryState: stepped.retryAuthorization } : {}) }
                : { mediaId: pending.mediaId, phase: 'PREPARING', busy: false,
                    completedRepresentatives: 0, totalRepresentatives: null };
              if (status?.phase === 'RETRY_REQUIRED') return { job: await updateCreativePortfolio(id, current =>
                finishPortfolioPreparationFailure(current, token, state,
                  'Video preparation was interrupted after provider work. Explicit Retry is required.'), storage) };
              return { job: await updateCreativePortfolio(id, current => finishPortfolioPreparation(current, token, state), storage) };
            }
            if (!state.sourceAnalysis) {
              state.sourceAnalysis = (await advancePlanningSourceAnalysis(job.request, undefined, () => {
                throw new Error('Source inventory initialization unexpectedly started provider work.');
              })).state;
            }
            const completed = await Promise.all((state.videoDependencies ?? []).map(async dependency => ({ dependency,
              library: await loadVideoIntelligenceLibrary(dependency.identity, dependency.completed!.artifact,
                { storage }) })));
            state.sourceAnalysis = projectCompletedVideoIntelligence(state.sourceAnalysis, completed, job.request.context);
            delete state.videoProgress; delete state.videoRetryAuthorization;
            return { job: await updateCreativePortfolio(id, current => finishPortfolioPreparation(current, token, state), storage) };
          }
        }
        const result = await advancePortfolioPreparation(
          job.request,
          requestUrl,
          job.planning.preparation,
          () => { providerWorkStarted = true; },
          job.sourceCompositionVersion,
        );
        if (result.state) {
          return { job: await updateCreativePortfolio(id, current => finishPortfolioPreparation(current, token, result.state), storage) };
        }
        const prepared = result.prepared;
        if (!prepared.plannerArgs) throw new Error('Creative planning context was not preserved.');
        const checkpoint = { snapshot: snapshotCreativePortfolio(prepared), plannerArgs: structuredClone(prepared.plannerArgs) };
        return { job: await updateCreativePortfolio(id, current => finishPortfolioInitialPlan(current, token, checkpoint), storage) };
      }
      if (job.planning.phase === 'DIVERSITY_AUDIT') {
        const { checkpoint, repairAttempted } = job.planning;
        checkpoint.snapshot.batchPlan.creatives.forEach(assertValidPlannedCreativeCopy);
        providerWorkStarted = true;
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
        const { checkpoint, replacementIndexes } = job.planning;
        checkpoint.snapshot.batchPlan.creatives.forEach(assertValidPlannedCreativeCopy);
        providerWorkStarted = true;
        const audit = checkpoint.snapshot.batchPlan.portfolioAudit!;
        const issue = getCreativeDiversityIssue(checkpoint.snapshot.batchPlan.creatives, audit);
        if (!issue) throw new Error('Portfolio repair was requested without a diversity issue.');
        const lockedConcepts = checkpoint.snapshot.batchPlan.creatives
          .filter(concept => !replacementIndexes.includes(concept.index));
        const batchPlan = await requestCreativeBatch(checkpoint.plannerArgs, {
          replacementIndexes,
          lockedConcepts,
          portfolioAudit: audit,
        });
        return { job: await updateCreativePortfolio(id, current => finishPortfolioRepair(current, token, batchPlan), storage) };
      }
      throw new Error('Portfolio planning phase is not executable.');
    }

    const context = await restoreCreativePortfolio(job.snapshot!);
    const slot = job.slots[slotIndex - 1];
    const concept = context.batchPlan.creatives[slotIndex - 1];
    assertValidPlannedCreativeCopy(concept);
    const automaticVideoSelection = job.videoPreparationVersion === 1
      && !job.request.videoFrameSelection
      && !concept.strategy.approvedHumanId
      && !concept.strategy.humanSourceId
      && !context.providerImageSource
      && context.videoFrameSet !== null;
    if (automaticVideoSelection) {
      if (!context.sourceAnalysis) {
        throw new CreativeGenerationPreparationError('Durable automatic video selection is missing its frozen B1 source analysis.', 409);
      }
      const denied = await reserveWorkQuota(slot.videoSelection?.selection ? 'CREATIVE_GENERATION' : 'VIDEO_SELECTION');
      if (denied) return denied;
      const inventory = await hydratePlanningSourceInventory(job.request.sourceAssets, context.storage);
      const videoSources = inventory.filter(({ source }) => source.role === 'TRA_VIDEO')
        .map(({ source }) => source as HydratedTraVideoSource);
      if (!slot.videoSelection?.selection) {
        let attempt: ReturnType<typeof checkpointPortfolioVideoSelectionAttempt> | undefined;
        await updateCreativePortfolio(id, current => {
          attempt = checkpointPortfolioVideoSelectionAttempt(
            current, token, (process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra').trim(),
          );
          return attempt.job;
        }, storage);
        if (!attempt) throw new Error('Video frame selection attempt was not checkpointed.');
        await assertCurrentWork();
        providerWorkStarted = true;
        const selected = await selectPortfolioVideoFrames({
          sourceAnalysis: context.sourceAnalysis,
          sources: videoSources,
          finalConcept: concept,
          cache: { model: attempt.selectionModel, deadlineAtMs, retry: attempt.retry, ...(storage ? { storage } : {}) },
        });
        if (selected.status === 'BUSY') return {
          job: await updateCreativePortfolio(id, current => releasePortfolioWork(current, token), storage),
          status: 202,
          retryAfterSeconds: 2,
        };
        if (selected.status === 'RETRY_REQUIRED') {
          return { job: await updateCreativePortfolio(id, current => failPortfolioWork(current, token,
            `Video frame selection requires explicit Retry (${selected.reason}).`), storage) };
        }
        return { job: await updateCreativePortfolio(id, current =>
          finishPortfolioVideoFrameSelection(current, token, selected.selection), storage) };
      }

      providerWorkStarted = true;
      const selectedFrames = await hydratePortfolioVideoFrameSelection({
        sourceAnalysis: context.sourceAnalysis,
        sources: videoSources,
        selection: slot.videoSelection.selection,
      });
      const generatedVideoFrameSelection: GeneratedVideoFrameSelection = {
        libraryId: slot.videoSelection.selection.libraryId,
        sourceVideoMediaId: selectedFrames.source.media.id,
        sourceVideoContentHash: selectedFrames.sourceVideoContentHash,
        frames: selectedFrames.selectionProvenance,
      };
      const creative = await renderPlannedCreative(concept, {
        ...context,
        videoFrameSet: selectedFrames,
        generatedVideoFrameSelection,
      }, { creativeId: slot.creativeId, assertCurrentWork });
      return { job: await updateCreativePortfolio(id, current => finishPortfolioSlot(current, token, creative.id), storage) };
    }

    const denied = await reserveWorkQuota('CREATIVE_GENERATION');
    if (denied) return denied;
    providerWorkStarted = true;
    const creative = await renderPlannedCreative(concept, context, {
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
      return providerWorkStarted || error instanceof InvalidPlannedCreativeCopyError
        ? failPortfolioWork(value, token, message)
        : releasePortfolioWork(value, token);
    }, storage);
    return { job: current, error: message, status: error instanceof OperatorQuotaUnavailableError ? 503
      : error instanceof CreativeGenerationPreparationError ? error.status : 500 };
  }
}
