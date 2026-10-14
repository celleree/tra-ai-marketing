import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverBoundCaseCrop } from '@/lib/creatives/portfolio-bound-case-recovery';
import { proposeCaseAmendment } from '@/lib/creatives/portfolio-case-amendment';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { reserveImageAttempt, settleImageAttempt } from '@/lib/creatives/image-attempt-store';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';
import { videoCasePortfolio } from '../fixtures/video-case-portfolio';
const list = vi.hoisted(() => vi.fn());
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: list }));
beforeEach(() => list.mockResolvedValue([]));
async function setup() {
  const { job, pairs } = videoCasePortfolio(); job.videoCaseAmendment = proposeCaseAmendment(job, pairs).amendment;
  job.slots[0].status = 'SAVED'; job.slots[1].status = 'BLOCKED';
  job.slots[1].error = 'No suitable human frame was found. Create a new portfolio with a clearer approved source.';
  job.slots[1].videoSelection = { version: 2, selectionModel: 'gpt-6-luna', selectionPolicy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY,
    reuseContext: { version: 1, frames: [] } };
  const storage = new MemoryPortfolioStorage(), path = `creative-portfolios/v1/${job.id}.json`;
  const write = async () => storage.write(path, Buffer.from(JSON.stringify(job)), (await storage.read(path))?.etag ?? null);
  await write(); return { job, storage, write };
}
const reserve = (id: string, operationId: string, storage: MemoryPortfolioStorage) => reserveImageAttempt({ runId: `portfolio:${id}`,
  operationId, kind: 'primary', fingerprint: 'a'.repeat(64), budget: { purpose: 'staging-smoke', primaryLimit: 2, fallbackLimit: 0 } }, storage);

describe('explicit bound case crop recovery', () => {
  it('preserves saved slot, immutable intent and existing ledger, and is idempotent without paid dispatch', async () => {
    const { job, storage } = await setup(); await reserve(job.id, job.slots[0].creativeId, storage);
    const ledger = [...storage.data.entries()].find(([key]) => key.startsWith('paid-image-runs/'))!;
    const original = structuredClone(job), recovered = await recoverBoundCaseCrop(job.id, 2, storage);
    expect(recovered.slots[0]).toEqual(original.slots[0]); expect(recovered.snapshot).toEqual(original.snapshot);
    expect(recovered.videoCaseAmendment).toEqual(original.videoCaseAmendment);
    expect(recovered.slots[1]).toMatchObject({ status: 'PENDING', boundCaseCropRecovery: { version: 1, previousError: original.slots[1].error } });
    expect(recovered.lease).toBeNull(); expect(storage.data.get(ledger[0])).toEqual(ledger[1]);
    expect(parseCreativePortfolioJob(Buffer.from(JSON.stringify(recovered)), job.id)).toEqual(recovered);
    expect(await recoverBoundCaseCrop(job.id, 2, storage)).toEqual(recovered);
  });
  it('ordinary updates cannot reopen a blocked slot, and recovery history cannot be cleared', async () => {
    const { job, storage } = await setup();
    await expect(updateCreativePortfolio(job.id, current => {
      current.slots[1].status = 'PENDING'; delete current.slots[1].error; return current;
    }, storage)).rejects.toThrow('may not replace');
    await recoverBoundCaseCrop(job.id, 2, storage);
    await expect(updateCreativePortfolio(job.id, current => {
      delete current.slots[1].boundCaseCropRecovery; return current;
    }, storage)).rejects.toThrow('may not replace');
  });
  it.each(['RESERVED', 'UNKNOWN', 'COMPLETE', 'FAILED'] as const)('refuses target paid attempt: %s', async status => {
    const { job, storage } = await setup(), claim = await reserve(job.id, job.slots[1].creativeId, storage);
    if (status !== 'RESERVED' && claim.status === 'CLAIMED') await settleImageAttempt({ runId: `portfolio:${job.id}`,
      operationId: job.slots[1].creativeId, kind: 'primary', token: claim.token }, status === 'COMPLETE'
      ? { status, result: { sha256: 'b'.repeat(64), byteLength: 10 } } : status === 'FAILED' ? { status, retryable: false } : { status }, storage);
    await expect(recoverBoundCaseCrop(job.id, 2, storage)).rejects.toThrow('image attempts');
    expect(await readCreativePortfolio(job.id, storage)).toEqual(job);
  });
  it.each(['saved-target', 'other-pending', 'active', 'different-failure', 'selected'])('refuses incompatible state: %s', async mode => {
    const { job, storage, write } = await setup();
    if (mode === 'saved-target') list.mockResolvedValue([{ id: job.slots[1].creativeId }]);
    if (mode === 'other-pending') job.slots[0].status = 'PENDING';
    if (mode === 'active') job.lease = { id: 'owner', slotIndex: 1, expiresAtMs: Date.now() + 60_000 };
    if (mode === 'different-failure') job.slots[1].error = 'Provider outcome uncertain.';
    if (mode === 'selected') job.slots[1].videoSelection!.retryAuthorization = { version: 1 };
    await write(); await expect(recoverBoundCaseCrop(job.id, 2, storage)).rejects.toThrow();
  });
});
