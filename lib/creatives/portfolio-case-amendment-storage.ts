import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { claimCreativePortfolio, releasePortfolioWork } from '@/lib/creatives/portfolio-job';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { assertCaseAmendmentAvailable, validateCaseAmendment } from '@/lib/creatives/portfolio-case-amendment';
import { assertNoImageAttempts } from '@/lib/creatives/image-attempt-store';
import { listCreatives } from '@/lib/creatives/storage';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

/** Explicit save only: no extraction, planning, assessment, image or background continuation. */
export async function applyCaseAmendment(id: string, value: unknown, storage: VideoIntelligenceStorage = getVideoIntelligenceStorage()) {
  const existing = await readCreativePortfolio(id, storage);
  if (!existing) throw new Error('Creative portfolio was not found.');
  const amendment = validateCaseAmendment(existing, value);
  if (existing.videoCaseAmendment) {
    if (!isDeepStrictEqual(existing.videoCaseAmendment, amendment)) throw new Error('Applied case amendment is immutable.');
    return existing;
  }
  const token = randomUUID();
  const leased = await updateCreativePortfolio(id, current => {
    assertCaseAmendmentAvailable(current);
    validateCaseAmendment(current, amendment);
    return claimCreativePortfolio(current, Date.now(), token).job;
  }, storage);
  try {
    // The exclusive portfolio lease prevents a concurrent render while checking lost checkpoints.
    await assertNoImageAttempts(`portfolio:${id}`, storage);
    const records = await listCreatives();
    if (records.some(record => leased.slots.some(slot => slot.creativeId === record.id))) {
      throw new Error('Saved creative results exist. Reload saved progress before changing any intent.');
    }
    return await updateCreativePortfolio(id, current => {
      if (current.lease?.id !== token || current.lease.expiresAtMs <= Date.now()) throw new Error('Amendment lease is no longer current.');
      validateCaseAmendment(current, amendment);
      return { ...releasePortfolioWork(current, token), videoCaseAmendment: amendment };
    }, storage);
  } catch (error) {
    await updateCreativePortfolio(id, current => current.lease?.id === token && current.lease.expiresAtMs > Date.now()
      ? releasePortfolioWork(current, token) : current, storage);
    throw error;
  }
}
