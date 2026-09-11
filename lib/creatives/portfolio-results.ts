import { isDeepStrictEqual } from 'node:util';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { listCreatives } from '@/lib/creatives/storage';
import { updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import type { CreativeRecord, GeneratedCreative } from '@/lib/creatives/generated';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

/** Saved pixels are the result, not a reason to call a provider again. Source revalidation is for new renders. */
export function portfolioSavedCreatives(job: CreativePortfolioJob, records: CreativeRecord[]): GeneratedCreative[] {
  if (!job.snapshot) return [];
  return job.slots.flatMap(slot => {
    const record = records.find(record => record.id === slot.creativeId);
    if (!record) return [];
    const concept = job.snapshot!.batchPlan.creatives[slot.index - 1];
    const identity = buildCreativeIdentity({ creativeId: slot.creativeId, operation: 'GENERATE', strategy: concept.strategy });
    if (!isDeepStrictEqual(record.identity, identity) || !isDeepStrictEqual(record.copy, concept.copy)
      || record.format !== concept.format || record.placement !== job.request.placement) {
      throw new Error('Saved creative does not match its reserved portfolio concept.');
    }
    return [{ ...record, index: slot.index, format: concept.format, finalization: { status: 'SAVED' as const, createdAt: record.createdAt } }];
  });
}
export async function readPortfolioCreatives(job: CreativePortfolioJob) {
  return job.snapshot ? portfolioSavedCreatives(job, await listCreatives()) : [];
}

/** Recover a lost job checkpoint only from a matching saved record; never interrupt an active worker. */
export async function reconcilePortfolioResults(id: string, storage?: VideoIntelligenceStorage, now = Date.now()) {
  const records = await listCreatives();
  return updateCreativePortfolio(id, current => {
    if (!current.snapshot || (current.lease && current.lease.expiresAtMs > now)) return current;
    const savedIds = new Set(portfolioSavedCreatives(current, records).map(creative => creative.id));
    if (!current.slots.some(slot => slot.status !== 'SAVED' && savedIds.has(slot.creativeId))) return current;
    const next = structuredClone(current);
    for (const slot of next.slots) {
      if (!savedIds.has(slot.creativeId)) continue;
      slot.status = 'SAVED'; delete slot.error;
      if (next.lease?.slotIndex === slot.index) next.lease = null;
    }
    next.updatedAtMs = now;
    return next;
  }, storage);
}
