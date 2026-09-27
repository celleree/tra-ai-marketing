import { parsePortfolioVideoDependencies, UnsupportedVideoPreparationVersionError } from '@/lib/creatives/portfolio-video-dependency';
import { isDeepStrictEqual } from 'node:util';
import { CREATIVE_CATEGORIES } from '@/lib/creative-categories';
import { isCreativeFormat } from '@/lib/creative-formats';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { getCreativeDiversityIssue, getCreativeDiversityRepairPlan } from '@/lib/creatives/diversity';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';
import { parsePortfolioAudit } from '@/lib/creatives/portfolio-audit';
import { MAX_PORTFOLIO_CREATIVES, MAX_PORTFOLIO_VIDEO_SELECTION_MODEL_LENGTH,
  type CreativePortfolioJob, type PortfolioPlanningCheckpoint } from '@/lib/creatives/portfolio-job';
import type { CreativePortfolioSnapshot } from '@/lib/creatives/portfolio-snapshot';
import type { PortfolioPreparationState } from '@/lib/creatives/portfolio-preparation';
import { parsePlanningSourceAnalysis, validAnalysis, validSourceLayout } from '@/lib/creatives/planning-source-parser';
import { videoPlanningSelectorBinding } from '@/lib/creatives/video-intelligence-planning';
import { parseReferenceCatalog } from '@/lib/references/planning';
import { isApprovedHumanId } from '@/lib/video/approved-human';
import { parseGenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { HUMAN_FRAME_SELECTION_POLICY, LEGACY_HUMAN_FRAME_SELECTION_POLICY, METADATA_FRAME_SELECTION_POLICY,
  canonicalizeVideoFrameReuseContext } from '@/lib/video/human-frame-selection';
import { isSelectedPlanningProof } from '@/lib/proof/planning-selection';
import { isCreativeLogoPlacementContext } from '@/lib/creatives/logo-placement';

export const isPortfolioId = (id: string) => /^portfolio_[a-f0-9]{32}$/.test(id);
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => key in value);
const automaticVideoSelectionPolicies = new Set<string>([HUMAN_FRAME_SELECTION_POLICY, LEGACY_HUMAN_FRAME_SELECTION_POLICY, METADATA_FRAME_SELECTION_POLICY]);
const validVideoSelectorBindings = (value: unknown, context: string) => {
  if (!record(value) || !Array.isArray(value.entries)) return false;
  const expected = videoPlanningSelectorBinding(context);
  return value.entries.every(entry => !record(entry) || !record(entry.result) || entry.result.kind !== 'VIDEO_INTELLIGENCE'
    || !record(entry.result.intelligence) || entry.result.intelligence.projectionVersion !== 3
    || isDeepStrictEqual(entry.result.intelligence.selector, expected));
};

const validVideoRetry = (value: unknown) => {
  if (!record(value) || !exact(value, ['jobId', 'updatedAtMs', 'retry', 'etag'])
    || typeof value.jobId !== 'string' || !/^video-intelligence-job:[a-f0-9]{64}$/.test(value.jobId)
    || !time(value.updatedAtMs) || typeof value.etag !== 'string' || value.etag.length < 1 || value.etag.length > 500
    || !record(value.retry)) return false;
  const retry = value.retry;
  return exact(retry, ['phase', 'reason', ...('candidateIndexes' in retry ? ['candidateIndexes'] : []),
    ...('message' in retry ? ['message'] : [])])
    && ['TRANSCRIBING', 'OBSERVING'].includes(String(retry.phase))
    && ['LEASE_EXPIRED', 'PAID_WORK_FAILED', 'PAID_COMPLETION_UNCERTAIN'].includes(String(retry.reason))
    && (retry.message === undefined || (typeof retry.message === 'string' && retry.message.length <= 1000))
    && (retry.candidateIndexes === undefined || (Array.isArray(retry.candidateIndexes)
      && retry.candidateIndexes.length >= 1 && retry.candidateIndexes.length <= 2
      && retry.candidateIndexes.every(index => Number.isSafeInteger(index) && index >= 0)));
};

const validSlotVideoSelection = (value: unknown, slotStatus: string, job: CreativePortfolioJob) => {
  if (!record(value) || ![1, 2].includes(Number(value.version)) || typeof value.selectionModel !== 'string'
    || value.selectionModel.trim().length < 1 || value.selectionModel.length > MAX_PORTFOLIO_VIDEO_SELECTION_MODEL_LENGTH
    || job.videoPreparationVersion !== 1 || job.planning.phase !== 'READY_TO_RENDER' || !job.snapshot
    || !job.request.sourceAssets.some(source => source.role === 'TRA_VIDEO')) return false;
  const hasSelection = 'selection' in value, hasRetry = 'retryAuthorization' in value;
  const versionedKeys = value.version === 2 ? ['selectionPolicy', 'reuseContext'] : [];
  if (!exact(value, ['version', 'selectionModel', ...versionedKeys, ...(hasSelection ? ['selection'] : []), ...(hasRetry ? ['retryAuthorization'] : [])])
    || (hasSelection && !parseGenerateVideoFrameSelection(value.selection)) || (hasSelection && hasRetry)
    || (slotStatus === 'SAVED' && !hasSelection) || (slotStatus === 'BLOCKED' && (hasSelection || hasRetry))) return false;
  if (value.version === 2) {
    if (typeof value.selectionPolicy !== 'string' || !automaticVideoSelectionPolicies.has(value.selectionPolicy)) return false;
    try {
      if (!isDeepStrictEqual(value.reuseContext, canonicalizeVideoFrameReuseContext(value.reuseContext as never))) return false;
    } catch { return false; }
  }
  if (slotStatus === 'BLOCKED' && (value.version !== 2
    || (value.selectionPolicy !== HUMAN_FRAME_SELECTION_POLICY
      && value.selectionPolicy !== LEGACY_HUMAN_FRAME_SELECTION_POLICY))) return false;
  if (hasRetry) {
    if (slotStatus !== 'PENDING' || !record(value.retryAuthorization) || !exact(value.retryAuthorization, ['version'])
      || value.retryAuthorization.version !== 1) return false;
  }
  return true;
};

class UnsupportedSourceCompositionVersionError extends Error {
  constructor() { super('Unsupported portfolio source composition version. A compatible app version is required.'); }
}

const validSelectedReferences = (value: unknown) => Array.isArray(value) && value.every(selection => {
  if (!record(selection) || !text(selection.imageUrl) || !text(selection.selectionReason) || !record(selection.item)) return false;
  const item = selection.item;
  return typeof item.id === 'string' && /^media_[a-f0-9]{32}$/.test(item.id)
    && text(item.fileName) && text(item.originalName)
    && ['image/png', 'image/jpeg', 'image/webp'].includes(String(item.mimeType))
    && typeof item.size === 'number' && Number.isFinite(item.size) && item.size > 0
    && text(item.url) && text(item.addedAt) && Number.isFinite(Date.parse(String(item.addedAt)))
    && item.referenceType === 'layout'
    && typeof item.angle === 'string' && CREATIVE_CATEGORIES.includes(item.angle as (typeof CREATIVE_CATEGORIES)[number])
    && ['ai', 'manual', 'legacy', 'fallback'].includes(String(item.angleSource));
});

const validPreparation = (value: unknown, job: CreativePortfolioJob): value is PortfolioPreparationState => {
  if (!record(value) || typeof value.quotaReserved !== 'boolean') return false;
  if (value.videoDependencies !== undefined) {
    if (job.videoPreparationVersion !== 1) return false;
    const dependencies = parsePortfolioVideoDependencies(value.videoDependencies, job.request.sourceAssets);
    if (value.sourceAnalysis !== undefined) {
      const analysis = parsePlanningSourceAnalysis(value.sourceAnalysis, job.request.sourceAssets);
      if (dependencies.some(dependency => analysis.entries.some(entry =>
        entry.source.mediaId === dependency.identity.sourceVideoMediaId
        && entry.source.sha256 !== dependency.identity.sourceVideoContentHash))) return false;
    }
  }
  if (value.videoProgress !== undefined) {
    const progress = value.videoProgress;
    if (job.videoPreparationVersion !== 1 || !record(progress)
      || !exact(progress, ['mediaId', 'phase', 'busy', 'completedRepresentatives', 'totalRepresentatives',
        ...('retryState' in progress ? ['retryState'] : [])])
      || !job.request.sourceAssets.some(source => source.role === 'TRA_VIDEO' && source.mediaId === progress.mediaId)
      || !['PREPARING', 'TRANSCRIBING', 'OBSERVING', 'FINALIZING', 'COMPLETE', 'FAILED', 'RETRY_REQUIRED'].includes(String(progress.phase))
      || typeof progress.busy !== 'boolean' || !time(progress.completedRepresentatives)
      || (progress.totalRepresentatives !== null && !time(progress.totalRepresentatives))
      || (typeof progress.totalRepresentatives === 'number' && Number(progress.completedRepresentatives) > progress.totalRepresentatives)
      || (progress.phase === 'RETRY_REQUIRED' ? !validVideoRetry(progress.retryState) : progress.retryState !== undefined)) return false;
    if (progress.retryState && (!Array.isArray(value.videoDependencies) || !value.videoDependencies.some(dependency => record(dependency)
      && dependency.jobId === (progress.retryState as Record<string, unknown>).jobId && record(dependency.identity)
      && dependency.identity.sourceVideoMediaId === progress.mediaId))) return false;
  }
  if (value.videoRetryAuthorization !== undefined
    && (!validVideoRetry(value.videoRetryAuthorization) || !record(value.videoProgress)
      || !isDeepStrictEqual(value.videoRetryAuthorization, value.videoProgress.retryState))) return false;
  if (value.sourceAnalysis !== undefined) {
    parsePlanningSourceAnalysis(value.sourceAnalysis, job.request.sourceAssets);
    if (!validVideoSelectorBindings(value.sourceAnalysis, job.request.context)) return false;
  }
  if (value.analysis !== undefined && !validAnalysis(value.analysis)) return false;
  if (value.sourceLayout !== undefined && !validSourceLayout(value.sourceLayout)) return false;
  if (value.selectedReferences !== undefined && !validSelectedReferences(value.selectedReferences)) return false;
  if (value.referenceCatalog !== undefined && !parseReferenceCatalog(value.referenceCatalog)) return false;
  return true;
};

const validSnapshot = (
  snapshot: CreativePortfolioSnapshot,
  job: CreativePortfolioJob,
  auditMode: 'required' | 'forbidden' | 'optional',
  requireDiverse: boolean,
) => {
  try {
    if (snapshot.sourceAnalysis !== undefined) {
      parsePlanningSourceAnalysis(snapshot.sourceAnalysis, job.request.sourceAssets, true);
      parsePlanningSourceAnalysis(snapshot.sourceAnalysis, snapshot.requestedSources, true);
      if (!validVideoSelectorBindings(snapshot.sourceAnalysis, job.request.context)) return false;
    }
    const plan = snapshot.batchPlan;
    const audit = plan.portfolioAudit === undefined ? undefined : parsePortfolioAudit(plan.portfolioAudit);
    if (snapshot.version !== 1 || !isDeepStrictEqual(snapshot.request, job.request)
      || !Array.isArray(snapshot.referenceCatalog) || !validSelectedReferences(snapshot.selectedReferences)
      || !Array.isArray(snapshot.requestedSources) || !Array.isArray(snapshot.analysisSources) || !Array.isArray(snapshot.videoFrames)
      || snapshot.videoFrames.some(frame => !time(frame.timestampMs) || !/^[a-f0-9]{64}$/.test(frame.sha256))
      || !plan || !Array.isArray(plan.creatives) || plan.creatives.length !== job.slots.length
      || (auditMode === 'required' && !audit) || (auditMode === 'forbidden' && plan.portfolioAudit !== undefined)
      || (plan.portfolioAudit !== undefined && (!audit || audit.conceptCount !== job.slots.length))
      || plan.creatives.some((concept, index) => concept.index !== index + 1 || !isCreativeFormat(concept.format)
        || (concept.selectedProof !== undefined && concept.selectedProof !== null && !isSelectedPlanningProof(concept.selectedProof))
        || ![concept.copy.headline, concept.copy.primaryText].every(text) || typeof concept.copy.description !== 'string'
        || !parseCreativePlanning({ strategy: concept.strategy, selectionReason: concept.selectionReason,
          ...(concept.logoAnchor ? { logoAnchor: concept.logoAnchor } : {}),
          model: plan.plannerModel, reasoningEffort: plan.reasoningEffort,
          referenceCatalog: snapshot.referenceCatalog, ...(audit ? { portfolioAudit: audit } : {}) }))) return false;
    if (requireDiverse && audit && getCreativeDiversityIssue(plan.creatives, audit)) return false;
    return true;
  } catch { return false; }
};

const validCheckpoint = (value: unknown, job: CreativePortfolioJob, auditMode: 'required' | 'forbidden' | 'optional') => {
  if (!record(value) || !record(value.plannerArgs) || !record(value.snapshot)) return false;
  const checkpoint = value as unknown as PortfolioPlanningCheckpoint, args = checkpoint.plannerArgs;
  if (args.count !== job.slots.length || !text(args.context) || args.proofRetrievalQuery !== job.request.proofRetrievalQuery || !validAnalysis(args.analysis)
    || typeof args.hasApprovedHumanSource !== 'boolean'
    || (args.hasBrandLogo !== undefined && typeof args.hasBrandLogo !== 'boolean')
    || (args.hasBrandLogo !== undefined && args.hasBrandLogo !== Boolean(job.request.brandLogoMediaId))
    || (args.logoPlacement !== undefined && (!isCreativeLogoPlacementContext(args.logoPlacement)
      || args.logoPlacement.placement !== job.request.placement || !args.hasBrandLogo))
    || !isDeepStrictEqual(args.referenceCatalog ?? [], checkpoint.snapshot.referenceCatalog)
    || !isDeepStrictEqual(args.sourceAnalysis, checkpoint.snapshot.sourceAnalysis)
    || (args.sourceAnalysis !== undefined && !validVideoSelectorBindings(args.sourceAnalysis, job.request.context))) return false;
  if (args.approvedHumanOptions !== undefined && (!Array.isArray(args.approvedHumanOptions)
    || new Set(args.approvedHumanOptions.map(option => option?.id)).size !== args.approvedHumanOptions.length
    || args.approvedHumanOptions.some(option => !record(option) || !isApprovedHumanId(option.id)
      || !text(option.sourceName) || !text(option.description)))) return false;
  return validSnapshot(checkpoint.snapshot, job, auditMode, false);
};

/** Internal saved-state validation; never grants media or human-source eligibility. */
export function parseCreativePortfolioJob(bytes: Buffer, expectedId: string): CreativePortfolioJob {
  try {
    if (bytes.length > 2 * 1024 * 1024 || !isPortfolioId(expectedId)) throw new Error();
    const raw = JSON.parse(bytes.toString('utf8')) as CreativePortfolioJob & { planning?: unknown };
    if (raw.sourceCompositionVersion !== undefined && raw.sourceCompositionVersion !== 1 && raw.sourceCompositionVersion !== 2) {
      throw new UnsupportedSourceCompositionVersionError();
    }
    if (raw.videoPreparationVersion !== undefined && raw.videoPreparationVersion !== 1) throw new UnsupportedVideoPreparationVersionError();
    let planning: unknown = raw.planning ?? { phase: raw.snapshot ? 'READY_TO_RENDER' : 'INITIAL_PLAN' };
    if (record(planning) && planning.phase === 'INITIAL_PLAN' && !('preparation' in planning)) {
      planning = { phase: 'INITIAL_PLAN', preparation: { quotaReserved: false } };
    }
    const job = { ...raw, planning } as CreativePortfolioJob;
    if (job.version !== 1 || job.id !== expectedId || !time(job.createdAtMs) || !time(job.updatedAtMs)
      || job.updatedAtMs < job.createdAtMs || !text(job.request.context)
      || !validateGenerateCreativeRequest({ ...job.request, context: 'Saved portfolio' }, MAX_PORTFOLIO_CREATIVES).success
      || !Array.isArray(job.slots) || job.slots.length !== job.request.variationCount
      || new Set(job.slots.map(slot => slot.creativeId)).size !== job.slots.length
      || job.slots.some((slot, index) => slot.index !== index + 1 || !/^creative_[a-f0-9]{32}$/.test(slot.creativeId)
        || !['PENDING', 'SAVED', 'RETRY_REQUIRED', 'BLOCKED'].includes(slot.status)
        || (['RETRY_REQUIRED', 'BLOCKED'].includes(slot.status) ? !text(slot.error) : slot.error !== undefined)
        || (slot.status === 'BLOCKED' && slot.videoSelection === undefined)
        || (slot.videoSelection !== undefined && !validSlotVideoSelection(slot.videoSelection, slot.status, job)))
      || !record(job.planning) || !['INITIAL_PLAN', 'DIVERSITY_AUDIT', 'TARGETED_REPAIR', 'READY_TO_RENDER'].includes(job.planning.phase)) throw new Error();

    if (job.planning.phase === 'READY_TO_RENDER') {
      if (!job.snapshot || !validSnapshot(job.snapshot, job, 'required', true)) throw new Error();
    } else {
      if (job.snapshot !== null || job.slots.some(slot => slot.status !== 'PENDING')) throw new Error();
      if (job.planning.phase === 'INITIAL_PLAN') {
        if (!validPreparation(job.planning.preparation, job)) throw new Error();
      } else if (job.planning.phase === 'TARGETED_REPAIR') {
        const audit = job.planning.checkpoint?.snapshot?.batchPlan?.portfolioAudit;
        const expectedRepairPlan = audit
          ? getCreativeDiversityRepairPlan(job.planning.checkpoint.snapshot.batchPlan.creatives, audit)
          : { replacementIndexes: [], defects: [] };
        const savedRepair = job.planning as typeof job.planning & { repairPlan?: unknown; replacementIndexes?: unknown };
        if (savedRepair.repairPlan === undefined && expectedRepairPlan.replacementIndexes.length) {
          if (savedRepair.replacementIndexes !== undefined
            && !isDeepStrictEqual(savedRepair.replacementIndexes, expectedRepairPlan.replacementIndexes)) throw new Error();
          job.planning = { phase: 'TARGETED_REPAIR', checkpoint: job.planning.checkpoint, repairPlan: expectedRepairPlan };
        }
        if (!validCheckpoint(job.planning.checkpoint, job, 'required') || !audit
          || !getCreativeDiversityIssue(job.planning.checkpoint.snapshot.batchPlan.creatives, audit)
          || !job.planning.repairPlan
          || !isDeepStrictEqual(job.planning.repairPlan, expectedRepairPlan)) throw new Error();
      } else {
        if (typeof job.planning.repairAttempted !== 'boolean') throw new Error();
        const hasAudit = job.planning.checkpoint?.snapshot?.batchPlan?.portfolioAudit !== undefined;
        if (!validCheckpoint(job.planning.checkpoint, job, hasAudit ? 'required' : 'forbidden')
          || (hasAudit && (!job.planning.repairAttempted || !job.planningError
            || !getCreativeDiversityIssue(job.planning.checkpoint.snapshot.batchPlan.creatives,
              job.planning.checkpoint.snapshot.batchPlan.portfolioAudit)))) throw new Error();
      }
    }
    if (job.planningError !== undefined && (!text(job.planningError) || job.snapshot || job.lease)) throw new Error();
    if (job.lease !== null && (!text(job.lease.id) || !time(job.lease.expiresAtMs)
      || (job.lease.slotIndex === null ? job.snapshot !== null
        : !job.snapshot || job.slots.find(slot => slot.index === job.lease!.slotIndex)?.status !== 'PENDING'))) throw new Error();
    return job;
  } catch (error) {
    if (error instanceof UnsupportedSourceCompositionVersionError || error instanceof UnsupportedVideoPreparationVersionError) throw error;
    throw new Error('Saved creative portfolio is invalid.');
  }
}
