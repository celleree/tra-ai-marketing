import { isDeepStrictEqual } from 'node:util';
import { CREATIVE_CATEGORIES } from '@/lib/creative-categories';
import { isCreativeFormat } from '@/lib/creative-formats';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';
import { parsePortfolioAudit } from '@/lib/creatives/portfolio-audit';
import { MAX_PORTFOLIO_CREATIVES, type CreativePortfolioJob, type PortfolioPlanningCheckpoint } from '@/lib/creatives/portfolio-job';
import type { CreativePortfolioSnapshot } from '@/lib/creatives/portfolio-snapshot';
import type { PortfolioPreparationState } from '@/lib/creatives/portfolio-preparation';
import { parseLayoutBlueprint } from '@/lib/layouts/blueprint';
import { parseReferenceCatalog } from '@/lib/references/planning';
import { isApprovedHumanId, MAX_APPROVED_HUMAN_OPTIONS } from '@/lib/video/approved-human';

export const isPortfolioId = (id: string) => /^portfolio_[a-f0-9]{32}$/.test(id);
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const string = (value: unknown) => typeof value === 'string';
const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const textArray = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Match the provider analysis schema: required strings may legitimately be empty. */
const validAnalysis = (value: unknown) => record(value)
  && string(value.summary) && textArray(value.visibleText) && string(value.visualStructure) && string(value.hookOrAngle)
  && string(value.offerOrCta) && string(value.styleNotes) && textArray(value.preserve) && textArray(value.avoid)
  && textArray(value.unknowns) && typeof value.dominantCategory === 'string'
  && CREATIVE_CATEGORIES.includes(value.dominantCategory as (typeof CREATIVE_CATEGORIES)[number]);

const validSourceLayout = (value: unknown) => {
  if (!record(value) || typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || !text(value.analyzerModel) || typeof value.cacheHit !== 'boolean') return false;
  try { parseLayoutBlueprint(value.blueprint); return true; } catch { return false; }
};

const validPreparation = (value: unknown): value is PortfolioPreparationState => {
  if (!record(value) || typeof value.quotaReserved !== 'boolean') return false;
  if (value.analysis !== undefined && !validAnalysis(value.analysis)) return false;
  if (value.sourceLayout !== undefined && !validSourceLayout(value.sourceLayout)) return false;
  if (value.selectedReferences !== undefined && !Array.isArray(value.selectedReferences)) return false;
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
    const plan = snapshot.batchPlan;
    const audit = plan.portfolioAudit === undefined ? undefined : parsePortfolioAudit(plan.portfolioAudit);
    if (snapshot.version !== 1 || !isDeepStrictEqual(snapshot.request, job.request)
      || !Array.isArray(snapshot.referenceCatalog) || !Array.isArray(snapshot.selectedReferences)
      || !Array.isArray(snapshot.requestedSources) || !Array.isArray(snapshot.analysisSources) || !Array.isArray(snapshot.videoFrames)
      || snapshot.videoFrames.some(frame => !time(frame.timestampMs) || !/^[a-f0-9]{64}$/.test(frame.sha256))
      || !plan || !Array.isArray(plan.creatives) || plan.creatives.length !== job.slots.length
      || (auditMode === 'required' && !audit) || (auditMode === 'forbidden' && plan.portfolioAudit !== undefined)
      || (plan.portfolioAudit !== undefined && (!audit || audit.conceptCount !== job.slots.length))
      || plan.creatives.some((concept, index) => concept.index !== index + 1 || !isCreativeFormat(concept.format)
        || ![concept.copy.headline, concept.copy.primaryText].every(text) || typeof concept.copy.description !== 'string'
        || !parseCreativePlanning({ strategy: concept.strategy, selectionReason: concept.selectionReason,
          model: plan.plannerModel, reasoningEffort: plan.reasoningEffort,
          referenceCatalog: snapshot.referenceCatalog, ...(audit ? { portfolioAudit: audit } : {}) }))) return false;
    if (requireDiverse && audit && getCreativeDiversityIssue(plan.creatives, audit)) return false;
    return true;
  } catch { return false; }
};

const validCheckpoint = (value: unknown, job: CreativePortfolioJob, auditMode: 'required' | 'forbidden' | 'optional') => {
  if (!record(value) || !record(value.plannerArgs) || !record(value.snapshot)) return false;
  const checkpoint = value as unknown as PortfolioPlanningCheckpoint, args = checkpoint.plannerArgs;
  if (args.count !== job.slots.length || !text(args.context) || !validAnalysis(args.analysis)
    || typeof args.hasApprovedHumanSource !== 'boolean'
    || !isDeepStrictEqual(args.referenceCatalog ?? [], checkpoint.snapshot.referenceCatalog)) return false;
  if (args.approvedHumanOptions !== undefined && (!Array.isArray(args.approvedHumanOptions)
    || args.approvedHumanOptions.length > MAX_APPROVED_HUMAN_OPTIONS
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
        || !['PENDING', 'SAVED', 'RETRY_REQUIRED'].includes(slot.status)
        || (slot.status === 'RETRY_REQUIRED' ? !text(slot.error) : slot.error !== undefined))
      || !record(job.planning) || !['INITIAL_PLAN', 'DIVERSITY_AUDIT', 'TARGETED_REPAIR', 'READY_TO_RENDER'].includes(job.planning.phase)) throw new Error();

    if (job.planning.phase === 'READY_TO_RENDER') {
      if (!job.snapshot || !validSnapshot(job.snapshot, job, 'required', true)) throw new Error();
    } else {
      if (job.snapshot !== null || job.slots.some(slot => slot.status !== 'PENDING')) throw new Error();
      if (job.planning.phase === 'INITIAL_PLAN') {
        if (!validPreparation(job.planning.preparation)) throw new Error();
      } else if (job.planning.phase === 'TARGETED_REPAIR') {
        if (!validCheckpoint(job.planning.checkpoint, job, 'required')
          || !getCreativeDiversityIssue(job.planning.checkpoint.snapshot.batchPlan.creatives,
            job.planning.checkpoint.snapshot.batchPlan.portfolioAudit)) throw new Error();
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
  } catch { throw new Error('Saved creative portfolio is invalid.'); }
}
