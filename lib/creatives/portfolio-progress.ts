import type { CreativePortfolioJob, PortfolioPlanningPhase, PortfolioSlot } from '@/lib/creatives/portfolio-job';
import { MAX_PORTFOLIO_CREATIVES } from '@/lib/creatives/planned';

export type PortfolioProgress = {
  id: string; requestedCount: number; planReady: boolean; planningPhase: PortfolioPlanningPhase; slots: PortfolioSlot[]; planningError: string | null;
  lease: { slotIndex: number | null; expiresAtMs: number } | null;
};
/** The client needs progress and saved creatives, not the broad planning snapshot or lease token. */
export const portfolioProgress = (job: CreativePortfolioJob): PortfolioProgress => ({
  id: job.id, requestedCount: job.slots.length, planReady: Boolean(job.snapshot), planningPhase: job.planning.phase, slots: job.slots,
  planningError: job.planningError ?? null,
  lease: job.lease ? { slotIndex: job.lease.slotIndex, expiresAtMs: job.lease.expiresAtMs } : null,
});

export function parsePortfolioProgress(value: unknown): PortfolioProgress | null {
  const job = value as PortfolioProgress;
  if (!job || !/^portfolio_[a-f0-9]{32}$/.test(job.id) || typeof job.planReady !== 'boolean'
    || !['INITIAL_PLAN', 'DIVERSITY_AUDIT', 'TARGETED_REPAIR', 'READY_TO_RENDER'].includes(job.planningPhase)
    || job.planReady !== (job.planningPhase === 'READY_TO_RENDER')
    || !Number.isInteger(job.requestedCount) || job.requestedCount < 2 || job.requestedCount > MAX_PORTFOLIO_CREATIVES
    || !Array.isArray(job.slots) || job.slots.length !== job.requestedCount
    || new Set(job.slots.map(slot => slot?.creativeId)).size !== job.slots.length
    || job.slots.some((slot, index) => !slot || slot.index !== index + 1 || !/^creative_[a-f0-9]{32}$/.test(slot.creativeId)
      || !['PENDING', 'SAVED', 'RETRY_REQUIRED'].includes(slot.status) || (slot.error !== undefined && typeof slot.error !== 'string'))
    || (job.planningError !== null && typeof job.planningError !== 'string')
    || (job.lease !== null && (!job.lease || !Number.isSafeInteger(job.lease.expiresAtMs) || job.lease.expiresAtMs < 0
      || (job.lease.slotIndex !== null && (!Number.isInteger(job.lease.slotIndex) || job.lease.slotIndex < 1 || job.lease.slotIndex > job.requestedCount))))) return null;
  return job;
}
