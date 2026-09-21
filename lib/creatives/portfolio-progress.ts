import type { CreativePortfolioJob, PortfolioPlanningPhase, PortfolioSlot } from '@/lib/creatives/portfolio-job';
import { MAX_PORTFOLIO_CREATIVES } from '@/lib/creatives/planned';

export type PortfolioProgress = {
  id: string; requestedCount: number; planReady: boolean; planningPhase: PortfolioPlanningPhase; planningCheckpoint: number;
  preparationFingerprint?: string;
  videoPreparation?: { total: number; completed: number; phase: import('@/lib/video/intelligence-job').VideoIntelligenceJob['phase']; busy: boolean };
  slots: PortfolioSlot[]; planningError: string | null;
  lease: { slotIndex: number | null; expiresAtMs: number } | null;
};

/** Distinguish durable pre-plan saves that intentionally remain in INITIAL_PLAN. */
const planningCheckpoint = (job: CreativePortfolioJob) => {
  if (job.planning.phase !== 'INITIAL_PLAN') return 0;
  const preparation = job.planning.preparation;
  return Number(preparation.quotaReserved)
    + (preparation.videoDependencies?.length ?? 0)
    + (preparation.videoDependencies?.filter(dependency => dependency.completed).length ?? 0)
    + (preparation.videoProgress?.completedRepresentatives ?? 0)
    + Number(preparation.analysis !== undefined)
    + Number(preparation.sourceLayout !== undefined)
    + Number(preparation.selectedReferences !== undefined)
    + (preparation.referenceCatalog?.length ?? 0);
};

const preparationFingerprint = (job: CreativePortfolioJob) => {
  if (job.planning.phase !== 'INITIAL_PLAN') return undefined;
  // Browser-safe FNV-1a 32 checksum: this is a progress identity, not a security primitive.
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(job.planning.preparation)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const videoPreparation = (job: CreativePortfolioJob): PortfolioProgress['videoPreparation'] => {
  if (job.videoPreparationVersion !== 1) return undefined;
  const total = job.request.sourceAssets.filter(source => source.role === 'TRA_VIDEO').length;
  if (job.planning.phase !== 'INITIAL_PLAN') return { total, completed: total, phase: 'COMPLETE', busy: false };
  const preparation = job.planning.preparation;
  const completed = preparation.videoDependencies?.filter(dependency => dependency.completed).length ?? 0;
  return { total, completed, phase: completed === total ? 'COMPLETE' : preparation.videoProgress?.phase ?? 'PREPARING',
    busy: preparation.videoProgress?.busy ?? false };
};

/** The client needs progress and saved creatives, not the broad planning snapshot or lease token. */
export const portfolioProgress = (job: CreativePortfolioJob): PortfolioProgress => {
  const fingerprint = preparationFingerprint(job);
  const video = videoPreparation(job);
  return {
    id: job.id, requestedCount: job.slots.length, planReady: Boolean(job.snapshot), planningPhase: job.planning.phase,
    planningCheckpoint: planningCheckpoint(job), ...(fingerprint ? { preparationFingerprint: fingerprint } : {}),
    ...(video ? { videoPreparation: video } : {}),
    slots: job.slots, planningError: job.planningError ?? null,
    lease: job.lease ? { slotIndex: job.lease.slotIndex, expiresAtMs: job.lease.expiresAtMs } : null,
  };
};

export function parsePortfolioProgress(value: unknown): PortfolioProgress | null {
  const job = value as PortfolioProgress;
  if (!job || !/^portfolio_[a-f0-9]{32}$/.test(job.id) || typeof job.planReady !== 'boolean'
    || !['INITIAL_PLAN', 'DIVERSITY_AUDIT', 'TARGETED_REPAIR', 'READY_TO_RENDER'].includes(job.planningPhase)
    || !Number.isSafeInteger(job.planningCheckpoint) || job.planningCheckpoint < 0
    || (job.preparationFingerprint !== undefined && (!/^[a-f0-9]{8}$/.test(job.preparationFingerprint)
      || job.planningPhase !== 'INITIAL_PLAN'))
    || job.planReady !== (job.planningPhase === 'READY_TO_RENDER')
    || !Number.isInteger(job.requestedCount) || job.requestedCount < 2 || job.requestedCount > MAX_PORTFOLIO_CREATIVES
    || !Array.isArray(job.slots) || job.slots.length !== job.requestedCount
    || new Set(job.slots.map(slot => slot?.creativeId)).size !== job.slots.length
    || job.slots.some((slot, index) => !slot || slot.index !== index + 1 || !/^creative_[a-f0-9]{32}$/.test(slot.creativeId)
      || !['PENDING', 'SAVED', 'RETRY_REQUIRED'].includes(slot.status) || (slot.error !== undefined && typeof slot.error !== 'string'))
    || (job.videoPreparation !== undefined && (!job.videoPreparation || !Number.isSafeInteger(job.videoPreparation.total)
      || job.videoPreparation.total < 1 || !Number.isSafeInteger(job.videoPreparation.completed)
      || job.videoPreparation.completed < 0 || job.videoPreparation.completed > job.videoPreparation.total
      || !['PREPARING', 'TRANSCRIBING', 'OBSERVING', 'FINALIZING', 'COMPLETE', 'FAILED', 'RETRY_REQUIRED'].includes(job.videoPreparation.phase)
      || typeof job.videoPreparation.busy !== 'boolean'))
    || (job.planningError !== null && typeof job.planningError !== 'string')
    || (job.lease !== null && (!job.lease || !Number.isSafeInteger(job.lease.expiresAtMs) || job.lease.expiresAtMs < 0
      || (job.lease.slotIndex !== null && (!Number.isInteger(job.lease.slotIndex) || job.lease.slotIndex < 1 || job.lease.slotIndex > job.requestedCount))))) return null;
  return job;
}
