import { describe, expect, it } from 'vitest';
import {
  blockPortfolioVideoSelection,
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
import { HUMAN_FRAME_SELECTION_POLICY, METADATA_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
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
const emptyReuse = { version: 1 as const, frames: [] };
const checkpoint = (job: CreativePortfolioJob, leaseId: string, selectionModel: string, now: number) =>
  checkpointPortfolioVideoSelectionAttempt(job, leaseId, {
    selectionModel, selectionPolicy: METADATA_FRAME_SELECTION_POLICY, reuseContext: emptyReuse,
  }, now);
const metadataState = (selectionModel: string, extra: Record<string, unknown> = {}) => ({
  version: 2, selectionModel, selectionPolicy: METADATA_FRAME_SELECTION_POLICY, reuseContext: emptyReuse, ...extra,
});
const completed = () => {
  const frozen = checkpoint(leased(), 'slot', 'selection-model-a', 4_100).job;
  return finishPortfolioVideoFrameSelection(frozen, 'slot', selection, 4_200);
};
const frozenFailure = () => {
  const frozen = checkpoint(leased(), 'slot', 'selection-model-a', 4_100).job;
  return failPortfolioWork(frozen, 'slot', 'Selection outcome uncertain', 4_200);
};

describe('portfolio video selection persistence', () => {
  it('persists deterministic visual admission as terminal blocked state', () => {
    const current = leased();
    const blocked = blockPortfolioVideoSelection(current, 'slot', { selectionModel: 'selection-model-a',
      selectionPolicy: HUMAN_FRAME_SELECTION_POLICY, reuseContext: emptyReuse },
    'Create a new portfolio with a smaller video pool; saved creatives remain available.', 4_100);
    expect(blocked.lease).toBeNull();
    expect(blocked.slots[0]).toMatchObject({ status: 'BLOCKED', error: expect.stringContaining('smaller video pool'),
      videoSelection: { version: 2, selectionPolicy: HUMAN_FRAME_SELECTION_POLICY } });
    expect(() => retryPortfolioWork(blocked, 1, 4_200)).toThrow('does not require a retry');
    expect(parse(blocked)).toEqual(blocked);
    const mixed = claimCreativePortfolio(blocked, 4_300, 'next');
    expect(mixed.status).toBe('WORK'); expect(mixed.job.lease?.slotIndex).toBe(2);
    const terminal = structuredClone(blocked); terminal.slots[1].status = 'SAVED';
    expect(claimCreativePortfolio(terminal, 4_400).status).toBe('BLOCKED');
  });

  it('freezes visual policy and same-portfolio reuse inputs across reload and explicit retry', () => {
    const reuseContext = { version: 1 as const, frames: [{ libraryId: selection.libraryId,
      frameId: selection.frameIds[0], useCount: 1 }] };
    const attempted = checkpointPortfolioVideoSelectionAttempt(leased(), 'slot', {
      selectionModel: 'selection-model-a', selectionPolicy: HUMAN_FRAME_SELECTION_POLICY, reuseContext,
    }, 4_100);
    expect(attempted.job.slots[0].videoSelection).toEqual({ version: 2, selectionModel: 'selection-model-a',
      selectionPolicy: HUMAN_FRAME_SELECTION_POLICY, reuseContext });
    expect(parse(attempted.job)).toEqual(attempted.job);
    const failed = failPortfolioWork(attempted.job, 'slot', 'Selection outcome uncertain', 4_200);
    const retried = retryPortfolioWork(failed, 1, 5_000);
    const claimed = claimCreativePortfolio(retried, 5_100, 'retry-slot').job;
    const resumed = checkpointPortfolioVideoSelectionAttempt(claimed, 'retry-slot', {
      selectionModel: 'changed-model', selectionPolicy: 'metadata-frame-selection-v1', reuseContext: { version: 1, frames: [] },
    }, 5_200);
    expect(resumed.retry).toBe(true);
    expect(resumed.selectionModel).toBe('selection-model-a');
    expect(resumed.selectionPolicy).toBe(HUMAN_FRAME_SELECTION_POLICY);
    expect(resumed.reuseContext).toEqual(reuseContext);
    expect(parse(resumed.job)).toEqual(resumed.job);
  });

  it('loads an incomplete legacy v1 attempt and upgrades it without losing its frozen model', () => {
    const legacy = leased();
    legacy.slots[0].videoSelection = { version: 1, selectionModel: 'legacy-model' };
    expect(parse(legacy)).toEqual(legacy);
    const upgraded = checkpoint(legacy, 'slot', 'environment-model', 4_100);
    expect(upgraded.selectionModel).toBe('legacy-model');
    expect(upgraded.job.slots[0].videoSelection).toEqual(metadataState('legacy-model'));
    expect(parse(upgraded.job)).toEqual(upgraded.job);
  });

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
    const first = checkpoint(current, 'slot', 'selection-model-a', 4_100);
    expect(first.selectionModel).toBe('selection-model-a');
    expect(first.retry).toBe(false);
    expect(first.job.lease).toEqual(current.lease);
    expect(first.job.slots[0].videoSelection).toEqual(metadataState('selection-model-a'));

    const later = checkpoint(first.job, 'slot', 'selection-model-b', 4_200);
    expect(later.selectionModel).toBe('selection-model-a');
    expect(later.job.slots[0].videoSelection?.selectionModel).toBe('selection-model-a');
    expect(later.job.lease).toEqual(current.lease);
    expect(parse(later.job)).toEqual(later.job);
  });

  it('rejects an invalid selection model on the first attempt', () => {
    expect(() => checkpoint(leased(), 'slot', '   ', 4_100)).toThrow('model is invalid');
    expect(() => checkpoint(leased(), 'slot', 'x'.repeat(201), 4_100)).toThrow('model is invalid');
  });

  it('persists a COMPLETE selection, releases the lease, leaves the slot PENDING, and survives reload', () => {
    const job = completed();
    expect(job.lease).toBeNull();
    expect(job.slots[0].status).toBe('PENDING');
    expect(job.slots[0].videoSelection).toEqual({
      ...metadataState('selection-model-a'), selection,
    });
    expect(parse(job).slots[0].videoSelection).toEqual(job.slots[0].videoSelection);
  });

  it('cannot save a slot after selection starts until COMPLETE selection is persisted', () => {
    const frozen = checkpoint(leased(), 'slot', 'selection-model-a', 4_100).job;
    expect(() => finishPortfolioSlot(frozen, 'slot', frozen.slots[0].creativeId, 4_200))
      .toThrow('Completed video frame selection is required');
  });

  it('rejects serialized SAVED slots with incomplete video selection state', () => {
    const frozen = checkpoint(leased(), 'slot', 'selection-model-a', 4_100).job;
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
      ...metadataState('selection-model-a'), selection,
    });
    expect(parse(saved).slots[0].videoSelection).toEqual(saved.slots[0].videoSelection);
  });

  it('preserves the frozen model on selection failure and grants retry only after explicit operator retry', () => {
    const failed = frozenFailure();
    expect(failed.slots[0].status).toBe('RETRY_REQUIRED');
    expect(failed.slots[0].videoSelection).toEqual(metadataState('selection-model-a'));
    expect(parse(failed)).toEqual(failed);

    const retried = retryPortfolioWork(failed, 1, 5_000);
    expect(retried.slots[0].status).toBe('PENDING');
    expect(retried.slots[0].videoSelection).toEqual({
      ...metadataState('selection-model-a'), retryAuthorization: { version: 1 },
    });
    expect(parse(retried)).toEqual(retried);
  });

  it('consumes retry authorization in the attempt checkpoint before provider work and cannot replay it', () => {
    const retried = retryPortfolioWork(frozenFailure(), 1, 5_000);
    const claimed = claimCreativePortfolio(retried, 5_100, 'retry-slot').job;
    const attempt = checkpoint(claimed, 'retry-slot', 'environment-model-changed', 5_200);
    expect(attempt.retry).toBe(true);
    expect(attempt.selectionModel).toBe('selection-model-a');
    expect(attempt.job.lease).toEqual(claimed.lease);
    expect(attempt.job.slots[0].videoSelection).toEqual(metadataState('selection-model-a'));
    expect(parse(attempt.job)).toEqual(attempt.job);

    const second = checkpoint(attempt.job, 'retry-slot', 'another-model', 5_300);
    expect(second.retry).toBe(false);
    expect(second.job.slots[0].videoSelection?.retryAuthorization).toBeUndefined();
  });

  it('requires another explicit operator retry after a retried selection becomes uncertain again', () => {
    const authorized = retryPortfolioWork(frozenFailure(), 1, 5_000);
    const claimed = claimCreativePortfolio(authorized, 5_100, 'retry-slot').job;
    const consumed = checkpoint(claimed, 'retry-slot', 'selection-model-b', 5_200).job;
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
