import { describe, expect, it } from 'vitest';
import {
  checkpointPortfolioVideoSelectionAttempt,
  claimCreativePortfolio,
  failPortfolioWork,
  finishPortfolioPlan,
  finishPortfolioSlot,
  finishPortfolioVideoFrameSelection,
  newCreativePortfolio,
  releasePortfolioWork,
  retryPortfolioWork,
  type CreativePortfolioJob,
} from '@/lib/creatives/portfolio-job';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import type { GenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

const videoRequest = () => ({
  ...portfolioRequest(),
  sourceAssets: [{ mediaId: `media_${'a'.repeat(32)}`, role: 'TRA_VIDEO' as const }],
});
const ready = (video = true) => {
  const start = newCreativePortfolio(video ? videoRequest() : portfolioRequest(), 1_000);
  const claimed = claimCreativePortfolio(start, 2_000, 'plan').job;
  return finishPortfolioPlan(claimed, 'plan', portfolioSnapshot(claimed), 3_000);
};
const leased = () => claimCreativePortfolio(ready(), 4_000, 'slot').job;
const selection: GenerateVideoFrameSelection = {
  libraryId: `video-library:${'b'.repeat(64)}`,
  sourceVideoContentHash: 'c'.repeat(64),
  frameIds: [`video-frame:${'d'.repeat(64)}`],
};
const parse = (job: CreativePortfolioJob) => parseCreativePortfolioJob(Buffer.from(JSON.stringify(job)), job.id);
const completed = () => {
  const frozen = checkpointPortfolioVideoSelectionAttempt(leased(), 'slot', 'selection-model-a', 4_100).job;
  return finishPortfolioVideoFrameSelection(frozen, 'slot', selection, 4_200);
};
const frozenFailure = () => {
  const frozen = checkpointPortfolioVideoSelectionAttempt(leased(), 'slot', 'selection-model-a', 4_100).job;
  return failPortfolioWork(frozen, 'slot', 'Selection outcome uncertain', 4_200);
};

describe('portfolio video selection persistence', () => {
  it('keeps legacy video portfolios without slot selection state valid', () => {
    const job = ready();
    expect(parse(job)).toEqual(job);
    expect(job.slots[0].videoSelection).toBeUndefined();
  });

  it('keeps legacy SAVED video slots without selection state valid', () => {
    const current = leased();
    const saved = finishPortfolioSlot(current, 'slot', current.slots[0].creativeId, 4_100);
    expect(saved.slots[0].status).toBe('SAVED');
    expect(saved.slots[0].videoSelection).toBeUndefined();
    expect(parse(saved)).toEqual(saved);
  });

  it('freezes the first valid selection model, retains the lease, and ignores later model changes', () => {
    const current = leased();
    const first = checkpointPortfolioVideoSelectionAttempt(current, 'slot', 'selection-model-a', 4_100);
    expect(first.selectionModel).toBe('selection-model-a');
    expect(first.retry).toBe(false);
    expect(first.job.lease).toEqual(current.lease);
    expect(first.job.slots[0].videoSelection).toEqual({ version: 1, selectionModel: 'selection-model-a' });

    const later = checkpointPortfolioVideoSelectionAttempt(first.job, 'slot', 'selection-model-b', 4_200);
    expect(later.selectionModel).toBe('selection-model-a');
    expect(later.job.slots[0].videoSelection?.selectionModel).toBe('selection-model-a');
    expect(later.job.lease).toEqual(current.lease);
    expect(parse(later.job)).toEqual(later.job);
  });

  it('rejects an invalid selection model on the first attempt', () => {
    expect(() => checkpointPortfolioVideoSelectionAttempt(leased(), 'slot', '   ', 4_100)).toThrow('model is invalid');
    expect(() => checkpointPortfolioVideoSelectionAttempt(leased(), 'slot', 'x'.repeat(201), 4_100)).toThrow('model is invalid');
  });

  it('persists a COMPLETE selection, releases the lease, leaves the slot PENDING, and survives reload', () => {
    const job = completed();
    expect(job.lease).toBeNull();
    expect(job.slots[0].status).toBe('PENDING');
    expect(job.slots[0].videoSelection).toEqual({
      version: 1, selectionModel: 'selection-model-a', selection,
    });
    expect(parse(job).slots[0].videoSelection).toEqual(job.slots[0].videoSelection);
  });

  it('cannot save a slot after selection starts until COMPLETE selection is persisted', () => {
    const frozen = checkpointPortfolioVideoSelectionAttempt(leased(), 'slot', 'selection-model-a', 4_100).job;
    expect(() => finishPortfolioSlot(frozen, 'slot', frozen.slots[0].creativeId, 4_200))
      .toThrow('Completed video frame selection is required');
  });

  it('rejects serialized SAVED slots with incomplete video selection state', () => {
    const frozen = checkpointPortfolioVideoSelectionAttempt(leased(), 'slot', 'selection-model-a', 4_100).job;
    const modelOnly = structuredClone(frozen) as any;
    modelOnly.slots[0].status = 'SAVED';
    modelOnly.lease = null;
    expect(() => parse(modelOnly)).toThrow('invalid');

    const retryOnly = structuredClone(modelOnly) as any;
    retryOnly.slots[0].videoSelection.retryAuthorization = { version: 1 };
    expect(() => parse(retryOnly)).toThrow('invalid');
  });

  it('allows generation save after COMPLETE selection and retains it through reload', () => {
    const selected = completed();
    const generation = claimCreativePortfolio(selected, 5_000, 'generation').job;
    const saved = finishPortfolioSlot(generation, 'generation', generation.slots[0].creativeId, 5_100);
    expect(saved.slots[0].status).toBe('SAVED');
    expect(saved.slots[0].videoSelection).toEqual({
      version: 1, selectionModel: 'selection-model-a', selection,
    });
    expect(parse(saved).slots[0].videoSelection).toEqual(saved.slots[0].videoSelection);
  });

  it('preserves the frozen model on selection failure and grants retry only after explicit operator retry', () => {
    const failed = frozenFailure();
    expect(failed.slots[0].status).toBe('RETRY_REQUIRED');
    expect(failed.slots[0].videoSelection).toEqual({ version: 1, selectionModel: 'selection-model-a' });
    expect(parse(failed)).toEqual(failed);

    const retried = retryPortfolioWork(failed, 1, 5_000);
    expect(retried.slots[0].status).toBe('PENDING');
    expect(retried.slots[0].videoSelection).toEqual({
      version: 1, selectionModel: 'selection-model-a', retryAuthorization: { version: 1 },
    });
    expect(parse(retried)).toEqual(retried);
  });

  it('consumes retry authorization in the attempt checkpoint before provider work and cannot replay it', () => {
    const retried = retryPortfolioWork(frozenFailure(), 1, 5_000);
    const claimed = claimCreativePortfolio(retried, 5_100, 'retry-slot').job;
    const attempt = checkpointPortfolioVideoSelectionAttempt(claimed, 'retry-slot', 'environment-model-changed', 5_200);
    expect(attempt.retry).toBe(true);
    expect(attempt.selectionModel).toBe('selection-model-a');
    expect(attempt.job.lease).toEqual(claimed.lease);
    expect(attempt.job.slots[0].videoSelection).toEqual({ version: 1, selectionModel: 'selection-model-a' });
    expect(parse(attempt.job)).toEqual(attempt.job);

    const second = checkpointPortfolioVideoSelectionAttempt(attempt.job, 'retry-slot', 'another-model', 5_300);
    expect(second.retry).toBe(false);
    expect(second.job.slots[0].videoSelection?.retryAuthorization).toBeUndefined();
  });

  it('requires another explicit operator retry after a retried selection becomes uncertain again', () => {
    const authorized = retryPortfolioWork(frozenFailure(), 1, 5_000);
    const claimed = claimCreativePortfolio(authorized, 5_100, 'retry-slot').job;
    const consumed = checkpointPortfolioVideoSelectionAttempt(claimed, 'retry-slot', 'selection-model-b', 5_200).job;
    const failedAgain = failPortfolioWork(consumed, 'retry-slot', 'Uncertain again', 5_300);
    expect(failedAgain.slots[0].status).toBe('RETRY_REQUIRED');
    expect(failedAgain.slots[0].videoSelection?.retryAuthorization).toBeUndefined();

    const reload = claimCreativePortfolio(failedAgain, 5_400, 'other-slot');
    expect(reload.job.slots[0].status).toBe('RETRY_REQUIRED');
    expect(reload.job.lease?.slotIndex).toBe(2);
    const released = releasePortfolioWork(reload.job, 'other-slot', 5_500);
    const retriedAgain = retryPortfolioWork(released, 1, 5_600);
    expect(retriedAgain.slots[0].videoSelection?.retryAuthorization).toEqual({ version: 1 });
  });

  it('preserves completed selection through generation failure and does not authorize re-selection', () => {
    const selected = completed();
    const generation = claimCreativePortfolio(selected, 5_000, 'generation').job;
    const failed = failPortfolioWork(generation, 'generation', 'Render failed', 5_100);
    expect(failed.slots[0].videoSelection?.selection).toEqual(selection);

    const retried = retryPortfolioWork(failed, 1, 5_200);
    expect(retried.slots[0].status).toBe('PENDING');
    expect(retried.slots[0].videoSelection?.selection).toEqual(selection);
    expect(retried.slots[0].videoSelection?.retryAuthorization).toBeUndefined();
    expect(parse(retried)).toEqual(retried);
  });

  it('fails parser validation for malformed model, state, selection, and retry combinations', () => {
    const valid = completed();
    const badStates: unknown[] = [
      { version: 2, selectionModel: 'selection-model-a' },
      { version: 1, selectionModel: '' },
      { version: 1, selectionModel: 'x'.repeat(201) },
      { version: 1, selectionModel: 'selection-model-a', selection: { ...selection, frameIds: [] } },
      { version: 1, selectionModel: 'selection-model-a', selection, retryAuthorization: { version: 1 } },
      { version: 1, selectionModel: 'selection-model-a', retryAuthorization: { version: 1, reusable: true } },
      { version: 1, selectionModel: 'selection-model-a', extra: true },
    ];
    for (const videoSelection of badStates) {
      const job = structuredClone(valid) as any;
      job.slots[0].videoSelection = videoSelection;
      expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(job)), job.id)).toThrow('invalid');
    }

    const retryOnFailed = structuredClone(frozenFailure()) as any;
    retryOnFailed.slots[0].videoSelection.retryAuthorization = { version: 1 };
    expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(retryOnFailed)), retryOnFailed.id)).toThrow('invalid');

    const nonVideo = ready(false) as any;
    nonVideo.slots[0].videoSelection = { version: 1, selectionModel: 'selection-model-a' };
    expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(nonVideo)), nonVideo.id)).toThrow('invalid');

    const beforeReady = newCreativePortfolio(videoRequest(), 1_000) as any;
    beforeReady.slots[0].videoSelection = { version: 1, selectionModel: 'selection-model-a' };
    expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(beforeReady)), beforeReady.id)).toThrow('invalid');
  });
});
