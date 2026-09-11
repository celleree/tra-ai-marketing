import type { CreativePortfolioJob, PortfolioSlot } from '@/lib/creatives/portfolio-job';

export type PortfolioProgress = {
  id: string; requestedCount: number; planReady: boolean; slots: PortfolioSlot[]; planningError: string | null;
  lease: { slotIndex: number | null; expiresAtMs: number } | null;
};
/** The client needs progress and saved creatives, not the broad planning snapshot or lease token. */
export const portfolioProgress = (job: CreativePortfolioJob): PortfolioProgress => ({
  id: job.id, requestedCount: job.slots.length, planReady: Boolean(job.snapshot), slots: job.slots,
  planningError: job.planningError ?? null,
  lease: job.lease ? { slotIndex: job.lease.slotIndex, expiresAtMs: job.lease.expiresAtMs } : null,
});
