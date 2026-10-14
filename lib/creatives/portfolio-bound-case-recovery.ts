import { isDeepStrictEqual } from 'node:util';
import { caseReviewChoices, validateCaseAmendment } from '@/lib/creatives/portfolio-case-amendment';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { assertNoImageAttempts } from '@/lib/creatives/image-attempt-store';
import { listCreatives } from '@/lib/creatives/storage';
import { isPreviewTestPortfolio } from '@/lib/creatives/preview-portfolio-scope';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

function assertRecoverable(job: CreativePortfolioJob, slotIndex: number) {
  const slot = job.slots.find(item => item.index === slotIndex);
  if (!job.videoCaseAmendment || !job.snapshot || job.planning.phase !== 'READY_TO_RENDER'
    || job.videoPreparationVersion !== 1 || job.lease || job.previewAcceptanceError || isPreviewTestPortfolio(job)
    || !slot || slot.status !== 'BLOCKED' || slot.boundCaseCropRecovery
    || !slot.error?.startsWith('No suitable human frame was found.')
    || slot.videoSelection?.version !== 2 || slot.videoSelection.selection
    || slot.videoSelection.retryAuthorization || slot.videoSelection.selectionPolicy !== CANDIDATE_HUMAN_FRAME_SELECTION_POLICY
    || job.slots.some(other => other.index !== slotIndex && other.status !== 'SAVED')) {
    throw new Error('Only a blocked legacy bound-frame slot with all other outputs saved can be recovered once.');
  }
  validateCaseAmendment(job, job.videoCaseAmendment);
  if (caseReviewChoices(job, slotIndex)?.frames?.length !== 1) throw new Error('The exact confirmed frame is required.');
  return slot;
}

/** UI availability hint only; applying recovery still checks target attempts and persisted outputs. */
export function boundCaseCropRecoverySlot(job: CreativePortfolioJob): number | undefined {
  const index = job.slots.find(slot => slot.status === 'BLOCKED')?.index;
  if (index === undefined) return undefined;
  try { assertRecoverable(job, index); return index; } catch { return undefined; }
}

/** Explicit non-paid preparation only. No cache/ledger deletion, provider dispatch or automatic Resume. */
export async function recoverBoundCaseCrop(id: string, slotIndex: number,
  storage: VideoIntelligenceStorage = getVideoIntelligenceStorage()) {
  const existing = await readCreativePortfolio(id, storage);
  if (!existing) throw new Error('Creative portfolio was not found.');
  // An uncertain response can be read back/repeated without resetting or redispatching work.
  if (existing.slots.find(slot => slot.index === slotIndex)?.boundCaseCropRecovery) return existing;
  const slot = assertRecoverable(existing, slotIndex);
  // BLOCKED is terminal for ordinary advance; all other slots are SAVED, so no renderer can race these reads.
  await assertNoImageAttempts(`portfolio:${id}`, storage, slot.creativeId);
  if ((await listCreatives()).some(record => record.id === slot.creativeId)) {
    throw new Error('A saved result exists for this slot. Preserve it and reload progress.');
  }
  return updateCreativePortfolio(id, current => {
    assertRecoverable(current, slotIndex);
    if (!isDeepStrictEqual(current, existing)) throw new Error('Portfolio changed during recovery. Reload before continuing.');
    const next = structuredClone(current), target = next.slots.find(item => item.index === slotIndex)!;
    target.boundCaseCropRecovery = { version: 1, previousError: target.error! };
    target.status = 'PENDING'; delete target.error;
    // Preserve the frozen model/reuse context; the new contract has a separate assessment cache.
    next.updatedAtMs = Date.now();
    return next;
  }, storage, { boundCaseCropRecoverySlot: slotIndex });
}
