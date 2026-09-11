import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { CreativePortfolioSnapshot } from '@/lib/creatives/portfolio-snapshot';
import { MAX_PORTFOLIO_CREATIVES } from '@/lib/creatives/planned';
export { MAX_PORTFOLIO_CREATIVES } from '@/lib/creatives/planned';

export const PORTFOLIO_LEASE_MS = 10 * 60 * 1000;
export type PortfolioSlot = { index: number; creativeId: string; status: 'PENDING' | 'SAVED' | 'RETRY_REQUIRED'; error?: string };
export type CreativePortfolioJob = {
  version: 1; id: string; createdAtMs: number; updatedAtMs: number;
  request: ValidGenerateCreativeRequest; snapshot: CreativePortfolioSnapshot | null; slots: PortfolioSlot[];
  planningError?: string;
  lease: { id: string; slotIndex: number | null; expiresAtMs: number } | null;
};
export type PortfolioClaim = { status: 'WORK' | 'BUSY' | 'COMPLETE' | 'RETRY_REQUIRED'; job: CreativePortfolioJob };
const id = (prefix: string) => prefix + randomUUID().replaceAll('-', '');

export function newCreativePortfolio(request: ValidGenerateCreativeRequest, now = Date.now()): CreativePortfolioJob {
  if (!Number.isInteger(request.variationCount) || request.variationCount < 2 || request.variationCount > MAX_PORTFOLIO_CREATIVES) {
    throw new Error('A portfolio requires 2 to 36 creatives.');
  }
  return { version: 1, id: id('portfolio_'), createdAtMs: now, updatedAtMs: now, request: structuredClone(request),
    snapshot: null, lease: null, slots: Array.from({ length: request.variationCount }, (_, index) => ({
      index: index + 1, creativeId: id('creative_'), status: 'PENDING',
    })) };
}
const requireLease = (job: CreativePortfolioJob, leaseId: string, now: number) => {
  if (!job.lease || job.lease.id !== leaseId || job.lease.expiresAtMs <= now) throw new Error('Portfolio work lease is no longer current.');
  return job.lease;
};
const failed = (job: CreativePortfolioJob, message: string) => {
  const next = structuredClone(job);
  if (next.lease!.slotIndex === null) next.planningError = message;
  else {
    const slot = next.slots.find(slot => slot.index === next.lease!.slotIndex)!;
    slot.status = 'RETRY_REQUIRED'; slot.error = message;
  }
  next.lease = null;
  return next;
};

/** Expired work may have incurred provider cost. Never silently claim it again. */
export function claimCreativePortfolio(current: CreativePortfolioJob, now = Date.now(), leaseId: string = randomUUID()): PortfolioClaim {
  const job = structuredClone(current);
  if (job.lease) {
    if (job.lease.expiresAtMs > now) return { status: 'BUSY', job };
    return { status: 'RETRY_REQUIRED', job: { ...failed(job, 'Previous work was interrupted; its provider outcome may be uncertain. Explicit retry is required.'), updatedAtMs: now } };
  }
  const slot = job.snapshot ? job.slots.find(slot => slot.status === 'PENDING') : undefined;
  if (!job.snapshot && job.planningError) return { status: 'RETRY_REQUIRED', job };
  if (job.snapshot && !slot) return { status: job.slots.every(slot => slot.status === 'SAVED') ? 'COMPLETE' : 'RETRY_REQUIRED', job };
  job.lease = { id: leaseId, slotIndex: slot?.index ?? null, expiresAtMs: now + PORTFOLIO_LEASE_MS };
  job.updatedAtMs = now;
  return { status: 'WORK', job };
}

export function finishPortfolioPlan(current: CreativePortfolioJob, leaseId: string, snapshot: CreativePortfolioSnapshot, now = Date.now()) {
  const lease = requireLease(current, leaseId, now);
  if (lease.slotIndex !== null || current.snapshot || !isDeepStrictEqual(snapshot.request, current.request)
    || snapshot.batchPlan.creatives.length !== current.slots.length
    || snapshot.batchPlan.creatives.some((concept, index) => concept.index !== current.slots[index].index)) {
    throw new Error('Portfolio plan does not match the reserved slots.');
  }
  return { ...structuredClone(current), snapshot: structuredClone(snapshot), lease: null, updatedAtMs: now };
}

export function finishPortfolioSlot(current: CreativePortfolioJob, leaseId: string, creativeId: string, now = Date.now()) {
  const lease = requireLease(current, leaseId, now);
  const job = structuredClone(current);
  const slot = job.slots.find(slot => slot.index === lease.slotIndex);
  if (!job.snapshot || !slot || slot.creativeId !== creativeId || slot.status !== 'PENDING') throw new Error('Portfolio result does not match the reserved creative.');
  slot.status = 'SAVED'; delete slot.error;
  job.lease = null; job.updatedAtMs = now;
  return job;
}

export function failPortfolioWork(current: CreativePortfolioJob, leaseId: string, message: string, now = Date.now()) {
  requireLease(current, leaseId, now);
  return { ...failed(current, message.slice(0, 1000) || 'Creative work could not be completed.'), updatedAtMs: now };
}

/** Only for failures before any provider work, such as quota denial. */
export function releasePortfolioWork(current: CreativePortfolioJob, leaseId: string, now = Date.now()) {
  requireLease(current, leaseId, now);
  return { ...structuredClone(current), lease: null, updatedAtMs: now };
}

/** An explicit operator action; successful slots and the completed plan are never reset. */
export function retryPortfolioWork(current: CreativePortfolioJob, slotIndex: number | null, now = Date.now()) {
  if (current.lease) throw new Error('Portfolio work is still leased.');
  const job = structuredClone(current);
  if (slotIndex === null) {
    if (job.snapshot || !job.planningError) throw new Error('Portfolio planning does not require a retry.');
    delete job.planningError;
  } else {
    const slot = job.slots.find(slot => slot.index === slotIndex);
    if (!job.snapshot || !slot || slot.status !== 'RETRY_REQUIRED') throw new Error('This creative does not require a retry.');
    slot.status = 'PENDING'; delete slot.error;
  }
  job.updatedAtMs = now;
  return job;
}
