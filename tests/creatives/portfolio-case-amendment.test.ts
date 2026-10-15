import { requestedVideoCases } from '@/lib/creatives/requested-video-cases';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { proposeCaseAmendment, validateCaseAmendment, effectiveCaseConcept, caseReviewChoices, caseAmendmentOptions, caseAssociationNeedsReview, selectedCaseAssertion } from '@/lib/creatives/portfolio-case-amendment';
import { applyCaseAmendment } from '@/lib/creatives/portfolio-case-amendment-storage';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { reserveImageAttempt } from '@/lib/creatives/image-attempt-store';
import { buildCreativeRenderBrief } from '@/lib/creatives/render-brief';
import { assertDraftVideoAssertionCopy } from '@/lib/creatives/draft-video-assertion';
import { portfolioSavedCreatives } from '@/lib/creatives/portfolio-results';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';
import { videoCasePortfolio } from '../fixtures/video-case-portfolio';
import { PREVIEW_TEST_APPROVAL } from '@/lib/creatives/preview-test-binding';

const list = vi.hoisted(() => vi.fn());
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: list }));
beforeEach(() => { list.mockReset(); list.mockResolvedValue([]); });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
async function stored() {
  const fixture = videoCasePortfolio(), storage = new MemoryPortfolioStorage();
  await storage.write(`creative-portfolios/v1/${fixture.job.id}.json`, encode(fixture.job), null);
  return { ...fixture, storage };
}

describe('explicit source case amendments', () => {
  it('prefills ordinary planned cases without confirming identities and holds all provider work until exact pairings are saved', () => {
    const { job, pairs } = videoCasePortfolio();
    const cases = requestedVideoCases('Use the selected video case studies', job.request.reviewHandoff)!;
    job.snapshot!.batchPlan.creatives.forEach((concept, index) => {
      concept.draftSourceAssertion = cases[index];
      concept.strategy.execution.subjectSource = 'approved-tra-human';
    });
    expect(caseAssociationNeedsReview(job)).toBe(true);
    expect(caseAmendmentOptions(job).plannedPairs).toEqual(pairs.map(pair => ({ ...pair, frameId: '', attributionConfirmed: false })));
    expect(() => proposeCaseAmendment(job, [{ ...pairs[0], frameId: pairs[1].frameId }, pairs[1]])).toThrow('time window');
    const proposal = proposeCaseAmendment(job, pairs);
    job.videoCaseAmendment = proposal.amendment;
    expect(caseAssociationNeedsReview(job)).toBe(false);
    expect(caseReviewChoices(job, 1)?.frames).toEqual([job.request.reviewHandoff!.choices.frames![0]]);
    expect(caseReviewChoices(job, 2)?.frames).toEqual([job.request.reviewHandoff!.choices.frames![1]]);
    expect(effectiveCaseConcept(job, 1).draftSourceAssertion?.exactText).toBe(cases[0].exactText);
    expect(effectiveCaseConcept(job, 2).draftSourceAssertion?.exactText).toBe(cases[1].exactText);
  });

  it('holds personal source accounts without treating generic service statements as a person’s case', () => {
    const { job } = videoCasePortfolio(), concept = job.snapshot!.batchPlan.creatives[0];
    concept.strategy.execution.subjectSource = 'approved-tra-human';
    concept.draftSourceAssertion = selectedCaseAssertion(job.request.reviewHandoff, 0);
    expect(caseAssociationNeedsReview(job)).toBe(true);
    concept.draftSourceAssertion.exactText = 'A free consultation is available. Eligibility varies.';
    expect(caseAssociationNeedsReview(job)).toBe(false);
  });
  it('prepares two different source accounts without mutating the original, changing layouts or dispatching work', () => {
    const { job, pairs, segments } = videoCasePortfolio(), original = structuredClone(job);
    const proposed = proposeCaseAmendment(job, pairs);
    expect(job).toEqual(original);
    expect(proposed.providerOperations).toEqual({ transcription: 0, planning: 0, audit: 0,
      maximumFrameAssessments: 4, maximumPrimaryImages: 2, fallbackImages: 0 });
    proposed.creatives.forEach((concept, index) => {
      expect(concept.imageCopy?.shortSupport).toBe(segments[index].text);
      expect(concept.copy.primaryText).toBe(segments[index].text);
      expect(concept.strategy.referenceSelection).toEqual(original.snapshot!.batchPlan.creatives[index].strategy.referenceSelection);
      expect(buildCreativeRenderBrief({ concept, referenceCatalog: job.snapshot!.referenceCatalog }).layoutBlueprint)
        .toEqual(job.snapshot!.referenceCatalog[index].blueprint);
      expect(() => assertDraftVideoAssertionCopy(concept.draftSourceAssertion, concept)).not.toThrow();
    });
    expect(proposed.creatives[1].imageCopy).not.toEqual(original.snapshot!.batchPlan.creatives[1].imageCopy);
    expect(list).not.toHaveBeenCalled();
  });
  it('rejects a different person’s frame, unselected frames, missing case copy and unconfirmed attribution', () => {
    const { job, pairs } = videoCasePortfolio();
    expect(() => proposeCaseAmendment(job, [{ ...pairs[0], frameId: pairs[1].frameId }, pairs[1]])).toThrow('time window');
    expect(() => proposeCaseAmendment(job, [pairs[0], { ...pairs[1], frameId: 'unselected' }])).toThrow('time window');
    expect(() => proposeCaseAmendment(job, [pairs[0]])).toThrow('frozen portfolio');
    const proposed = proposeCaseAmendment(job, pairs.map(pair => ({ ...pair, attributionConfirmed: false })));
    expect(proposed.attributionNotice).toContain('do not verify speaker identity');
    expect(() => validateCaseAmendment(job, proposed.amendment)).toThrow('confirm its person');
    const concept = proposed.creatives[1]; concept.imageCopy!.shortSupport = 'A clearer process';
    expect(() => assertDraftVideoAssertionCopy(concept.draftSourceAssertion, concept)).toThrow('retain its exact');
  });
  it('keeps ambiguous model evidence visible and rejects graphic-only scenes', () => {
    const { job, pairs } = videoCasePortfolio();
    const context = job.request.reviewHandoff!.operatorSelectedSourceGuidance.frames![1];
    (context as { observationIsExactFrame: boolean }).observationIsExactFrame = false;
    expect(caseAmendmentOptions(job).claims[1].frames[0].observationIsExactFrame).toBe(false);
    expect(proposeCaseAmendment(job, pairs).attributionNotice).toContain('unverified');
    (context.observation as { sceneType: string }).sceneType = 'PROOF_GRAPHIC';
    expect(() => proposeCaseAmendment(job, pairs)).toThrow('selected human frame');
  });
  it('saves a separate immutable amendment on the same run and reconciles a lost response without another write', async () => {
    const { job, pairs, storage } = await stored(), original = encode(job.snapshot), ids = job.slots.map(slot => slot.creativeId);
    const { amendment } = proposeCaseAmendment(job, pairs);
    const saved = await applyCaseAmendment(job.id, amendment, storage);
    expect(encode(saved.snapshot)).toEqual(original); expect(saved.slots.map(slot => slot.creativeId)).toEqual(ids);
    expect(saved.lease).toBeNull(); expect(saved.slots.map(slot => slot.status)).toEqual(['PENDING', 'PENDING']);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(saved);
    const before = JSON.stringify([...storage.data]);
    expect(await applyCaseAmendment(job.id, amendment, storage)).toEqual(saved); expect(JSON.stringify([...storage.data])).toEqual(before);
    await expect(updateCreativePortfolio(job.id, current => ({ ...current, videoCaseAmendment: undefined }), storage)).rejects.toThrow('immutable');
    expect(caseReviewChoices(saved, 1)?.frames).toEqual([job.request.reviewHandoff!.choices.frames![0]]);
    expect(caseReviewChoices(saved, 2)?.frames).toEqual([job.request.reviewHandoff!.choices.frames![1]]);
  });
  it.each(['SAVED', 'RETRY_REQUIRED', 'LEASE', 'SELECTION', 'STOP', 'QA'])("preserves %s work instead of amending it", state => {
    const { job, pairs } = videoCasePortfolio();
    if (state === 'SAVED') job.slots[0].status = 'SAVED';
    if (state === 'RETRY_REQUIRED') { job.slots[0].status = 'RETRY_REQUIRED'; job.slots[0].error = 'Unknown outcome'; }
    if (state === 'LEASE') job.lease = { id: 'active', slotIndex: 1, expiresAtMs: Date.now() + 1000 };
    if (state === 'SELECTION') job.slots[0].videoSelection = { version: 1, selectionModel: 'gpt-6-luna' };
    if (state === 'STOP') job.previewAcceptanceError = 'Stopped';
    if (state === 'QA') job.id = PREVIEW_TEST_APPROVAL.portfolioId;
    const original = structuredClone(job);
    expect(() => proposeCaseAmendment(job, pairs)).toThrow('paused, unrendered'); expect(job).toEqual(original);
  });
  it('refuses existing paid or uncertain attempts and releases only its own lease', async () => {
    const { job, pairs, storage } = await stored();
    const { amendment } = proposeCaseAmendment(job, pairs);
    await reserveImageAttempt({ runId: `portfolio:${job.id}`, operationId: job.slots[0].creativeId,
      kind: 'primary', fingerprint: 'a'.repeat(64), budget: { purpose: 'staging-smoke', primaryLimit: 2, fallbackLimit: 0 } }, storage);
    const paidKey = `paid-image-runs/v1/${createHash('sha256').update(`portfolio:${job.id}`).digest('hex')}.json`;
    const receipt = (await storage.read(paidKey))!.bytes;
    await expect(applyCaseAmendment(job.id, amendment, storage)).rejects.toThrow('image attempts');
    const saved = await readCreativePortfolio(job.id, storage);
    expect(saved?.videoCaseAmendment).toBeUndefined(); expect(saved?.snapshot).toEqual(job.snapshot); expect(saved?.lease).toBeNull();
    expect((await storage.read(paidKey))!.bytes).toEqual(receipt);
  });
  it('does not overwrite a creative whose saved checkpoint was lost', async () => {
    const { job, pairs, storage } = await stored(); list.mockResolvedValue([{ id: job.slots[1].creativeId }]);
    await expect(applyCaseAmendment(job.id, proposeCaseAmendment(job, pairs).amendment, storage)).rejects.toThrow('Saved creative results exist');
    expect((await readCreativePortfolio(job.id, storage))?.videoCaseAmendment).toBeUndefined();
  });
  it('validates amendment readback and rejects stale original plans', async () => {
    const { job, pairs, storage } = await stored();
    const saved = await applyCaseAmendment(job.id, proposeCaseAmendment(job, pairs).amendment, storage);
    const changed = structuredClone(saved); changed.videoCaseAmendment!.pairs[1].frameId = pairs[0].frameId;
    expect(() => parseCreativePortfolioJob(encode(changed), changed.id)).toThrow('invalid');
    const stale = { ...saved.videoCaseAmendment!, baseSnapshotSha256: 'f'.repeat(64) };
    expect(() => validateCaseAmendment(saved, stale)).toThrow('frozen portfolio');
  });
  it('matches saved results to both amended wording and the exact person binding after refresh', async () => {
    const { job, pairs, storage } = await stored();
    const saved = await applyCaseAmendment(job.id, proposeCaseAmendment(job, pairs).amendment, storage);
    const concept = effectiveCaseConcept(saved, 2), binding = caseReviewChoices(saved, 2)!.frames![0], video = saved.request.reviewHandoff!.choices.video!;
    const record = { id: saved.slots[1].creativeId, identity: buildCreativeIdentity({ creativeId: saved.slots[1].creativeId,
      operation: 'GENERATE', strategy: concept.strategy }), copy: concept.copy, planning: { draftSourceAssertion: concept.draftSourceAssertion },
      format: concept.format, placement: saved.request.placement, createdAt: new Date().toISOString(), videoFrameSelection: {
        libraryId: video.libraryId, librarySha256: video.librarySha256, sourceVideoMediaId: video.locator.sourceVideoMediaId,
        sourceVideoContentHash: video.locator.sourceVideoContentHash, frames: [{ libraryFrameId: binding.frameId,
          representativeFrameId: binding.representativeFrameId, candidateIndex: binding.candidateIndex,
          timestampMs: binding.timestampMs, candidateFrameSha256: binding.frameSha256 }] } };
    expect(portfolioSavedCreatives(saved, [record as never])).toHaveLength(1);
    const wrong = structuredClone(record); wrong.videoFrameSelection.frames[0].libraryFrameId = pairs[0].frameId;
    expect(() => portfolioSavedCreatives(saved, [wrong as never])).toThrow('closed-pool');
    const generic = { ...record, copy: job.snapshot!.batchPlan.creatives[1].copy };
    expect(() => portfolioSavedCreatives(saved, [generic as never])).toThrow('reserved portfolio concept');
  });
});

it("pairs only human slots in a new mixed batch and never inserts a person case into a graphic ad", () => {
  const { job, pairs } = videoCasePortfolio(); job.request.peoplePercent = 50;
  job.snapshot!.batchPlan.creatives[0].strategy.execution.subjectSource = 'approved-tra-human';
  const graphic = structuredClone(job.snapshot!.batchPlan.creatives[1]);
  const proposed = proposeCaseAmendment(job, [pairs[0]]);
  expect(proposed.creatives[1]).toEqual(graphic); expect(proposed.creatives[1].draftSourceAssertion).toBeUndefined();
  expect(caseAmendmentOptions(job).slots.map(slot => slot.index)).toEqual([1]);
  expect(() => proposeCaseAmendment(job, pairs)).toThrow('frozen portfolio');
  job.videoCaseAmendment = proposed.amendment;
  expect(caseReviewChoices(job, 1)?.frames).toHaveLength(1); expect(caseReviewChoices(job, 2)?.frames).toBeNull();
  expect(effectiveCaseConcept(job, 2)).toEqual(graphic);
  expect(parseCreativePortfolioJob(encode(job), job.id).videoCaseAmendment).toEqual(proposed.amendment);
});
