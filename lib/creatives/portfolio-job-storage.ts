import { preservesVideoDependencies } from '@/lib/creatives/portfolio-video-dependency';
import { isDeepStrictEqual } from 'node:util';
import { newCreativePortfolio, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { isPortfolioId, parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const key = (id: string) => {
  if (!isPortfolioId(id)) throw new Error('Invalid creative portfolio ID.');
  return `creative-portfolios/v1/${id}.json`;
};
const bytes = (job: CreativePortfolioJob) => {
  const encoded = Buffer.from(JSON.stringify(job));
  parseCreativePortfolioJob(encoded, job.id);
  return encoded;
};
async function read(id: string, storage: VideoIntelligenceStorage) {
  const stored = await storage.read(key(id));
  return stored ? { job: parseCreativePortfolioJob(stored.bytes, id), etag: stored.etag } : null;
}
export async function readCreativePortfolio(id: string, storage = getVideoIntelligenceStorage()) {
  return (await read(id, storage))?.job ?? null;
}
export async function createCreativePortfolio(request: ValidGenerateCreativeRequest, storage = getVideoIntelligenceStorage(), now = Date.now()) {
  const job = newCreativePortfolio(request, now);
  if (!await storage.write(key(job.id), bytes(job), null)) throw new Error('Creative portfolio could not be created.');
  return job;
}

/** Apply synchronous, side-effect-free state transitions against the latest stored version. */
export async function updateCreativePortfolio(
  id: string, change: (current: CreativePortfolioJob) => CreativePortfolioJob, storage = getVideoIntelligenceStorage(),
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await read(id, storage);
    if (!current) throw new Error('Creative portfolio was not found.');
    const next = change(structuredClone(current.job));
    // Preserve the stored marker exactly, including its absence on historical portfolios.
    if (next.sourceCompositionVersion !== current.job.sourceCompositionVersion) {
      throw new Error('Portfolio source composition version is immutable.');
    }
    if (next.videoPreparationVersion !== current.job.videoPreparationVersion) {
      throw new Error('Portfolio video preparation version is immutable.');
    }
    const dependencies = (job: CreativePortfolioJob) => job.planning.phase === 'INITIAL_PLAN' ? job.planning.preparation.videoDependencies ?? [] : [];
    if (!preservesVideoDependencies(dependencies(current.job), dependencies(next))) {
      throw new Error('Portfolio video dependency bindings and completed references are immutable.');
    }
    if (next.id !== id || next.createdAtMs !== current.job.createdAtMs || next.updatedAtMs < current.job.updatedAtMs
      || !isDeepStrictEqual(next.request, current.job.request)
      || !isDeepStrictEqual(next.slots.map(slot => [slot.index, slot.creativeId]), current.job.slots.map(slot => [slot.index, slot.creativeId]))
      || (current.job.snapshot && !isDeepStrictEqual(next.snapshot, current.job.snapshot))
      || current.job.slots.some((slot, index) => slot.status === 'SAVED' && next.slots[index].status !== 'SAVED')) {
      throw new Error('Portfolio update may not replace its request, plan, identities or completed work.');
    }
    if (isDeepStrictEqual(next, current.job)) return current.job;
    if (await storage.write(key(id), bytes(next), current.etag)) return next;
  }
  throw new Error('Creative portfolio changed concurrently. Reload its current progress.');
}
