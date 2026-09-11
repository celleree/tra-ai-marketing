import { isDeepStrictEqual } from 'node:util';
import { isCreativeFormat } from '@/lib/creative-formats';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';
import { MAX_PORTFOLIO_CREATIVES, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';

export const isPortfolioId = (id: string) => /^portfolio_[a-f0-9]{32}$/.test(id);
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

/** Internal saved-state validation; never grants media or human-source eligibility. */
export function parseCreativePortfolioJob(bytes: Buffer, expectedId: string): CreativePortfolioJob {
  try {
    if (bytes.length > 2 * 1024 * 1024 || !isPortfolioId(expectedId)) throw new Error();
    const job = JSON.parse(bytes.toString('utf8')) as CreativePortfolioJob;
    if (job.version !== 1 || job.id !== expectedId || !time(job.createdAtMs) || !time(job.updatedAtMs)
      || job.updatedAtMs < job.createdAtMs || !text(job.request.context)
      // Stored context already includes Company context. Validate request fields without wrapping it again.
      || !validateGenerateCreativeRequest({ ...job.request, context: 'Saved portfolio' }, MAX_PORTFOLIO_CREATIVES).success
      || !Array.isArray(job.slots) || job.slots.length !== job.request.variationCount
      || new Set(job.slots.map(slot => slot.creativeId)).size !== job.slots.length
      || job.slots.some((slot, index) => slot.index !== index + 1 || !/^creative_[a-f0-9]{32}$/.test(slot.creativeId)
        || !['PENDING', 'SAVED', 'RETRY_REQUIRED'].includes(slot.status)
        || (slot.status === 'RETRY_REQUIRED' ? !text(slot.error) : slot.error !== undefined))) throw new Error();
    if (job.snapshot !== null) {
      const snapshot = job.snapshot, plan = snapshot.batchPlan;
      if (snapshot.version !== 1 || !isDeepStrictEqual(snapshot.request, job.request)
        || !Array.isArray(snapshot.referenceCatalog) || !Array.isArray(snapshot.selectedReferences)
        || !Array.isArray(snapshot.requestedSources) || !Array.isArray(snapshot.analysisSources) || !Array.isArray(snapshot.videoFrames)
        || snapshot.videoFrames.some(frame => !time(frame.timestampMs) || !/^[a-f0-9]{64}$/.test(frame.sha256))
        || plan.creatives.length !== job.slots.length || !plan.portfolioAudit
        || plan.creatives.some((concept, index) => concept.index !== index + 1 || !isCreativeFormat(concept.format)
          || ![concept.copy.headline, concept.copy.primaryText].every(text) || typeof concept.copy.description !== 'string'
          || !parseCreativePlanning({ strategy: concept.strategy, selectionReason: concept.selectionReason,
            model: plan.plannerModel, reasoningEffort: plan.reasoningEffort,
            referenceCatalog: snapshot.referenceCatalog, portfolioAudit: plan.portfolioAudit }))
        || getCreativeDiversityIssue(plan.creatives, plan.portfolioAudit)) throw new Error();
    } else if (job.slots.some(slot => slot.status !== 'PENDING')) throw new Error();
    if (job.planningError !== undefined && (!text(job.planningError) || job.snapshot || job.lease)) throw new Error();
    if (job.lease !== null && (!text(job.lease.id) || !time(job.lease.expiresAtMs)
      || (job.lease.slotIndex === null ? job.snapshot !== null
        : !job.snapshot || job.slots.find(slot => slot.index === job.lease!.slotIndex)?.status !== 'PENDING'))) throw new Error();
    return job;
  } catch { throw new Error('Saved creative portfolio is invalid.'); }
}
