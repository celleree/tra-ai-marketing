import { isDeepStrictEqual } from 'node:util';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import { parseDraftVideoSourceAssertion, type DraftVideoSourceAssertion } from '@/lib/creatives/draft-video-assertion';
import type { VideoReviewHandoff } from '@/lib/creatives/review-handoff';
import { isPreviewTestPortfolio } from '@/lib/creatives/preview-portfolio-scope';
import { reviewSourceSha256, record, ReviewSelectionError } from '@/lib/video/review-selection';

export type VideoCasePair = { slotIndex: number; claimIndex: number; frameId: string; attributionConfirmed: boolean };
export type VideoCaseAmendment = { version: 1; intent: 'VIDEO_CASE_STUDY'; baseSnapshotSha256: string; pairs: VideoCasePair[] };
const deny = (message: string): never => { throw new ReviewSelectionError(message, 409); };
export const CASE_ATTRIBUTION_NOTICE = 'Timestamp overlap and cached scene observations do not verify speaker identity. Confirm that this statement belongs to this person after reviewing the video and surrounding qualifications. Do not combine separate speakers’ accounts. These are unverified source accounts, not approved Proof.';

/** Exact selected source wording, never a synthesized result or OCR-derived amount/name. */
export function selectedCaseAssertion(handoff: VideoReviewHandoff | undefined, claimIndex: number): DraftVideoSourceAssertion {
  const video = handoff?.choices.video, claim = handoff?.claimSnapshots[claimIndex];
  if (!video || !claim || claim.reference.type !== 'VIDEO_TRANSCRIPT' || claim.context.type !== 'VIDEO_TRANSCRIPT'
    || !claim.context.segments.length || claim.wording !== claim.context.segments.map(segment => segment.text).join(' ')
    || claim.wording.length > 900) return deny('Select a complete saved video transcript statement; no wording will be shortened or invented.');
  const segments = claim.context.segments;
  const reference = claim.reference;
  if (segments.some((segment, index) => segment.segmentIndex !== reference.startSegmentIndex + index
    || segment.endMs <= segment.startMs || (index > 0 && segment.startMs < segments[index - 1].endMs))
    || segments.at(-1)!.segmentIndex !== reference.endSegmentIndex) return deny('The selected transcript range is inconsistent.');
  const assertion: DraftVideoSourceAssertion = { passageId: `review-case:${handoff!.handoffSha256}:${claimIndex}`, sourceMediaId: video.locator.sourceVideoMediaId,
    sourceSha256: video.locator.sourceVideoContentHash, libraryId: video.libraryId, kind: 'TRANSCRIPT',
    startMs: segments[0].startMs, endMs: segments.at(-1)!.endMs, exactText: claim.wording,
    contextSegments: structuredClone([...segments]), uncertainties: [CASE_ATTRIBUTION_NOTICE],
    verification: 'UNVERIFIED_SOURCE_ASSERTION', permission: 'REQUIRES_REVIEW', contextCoverage: 'BOUNDED', imageField: 'shortSupport' };
  if (!parseDraftVideoSourceAssertion(assertion)) return deny('The selected source statement is incomplete or invalid.');
  return assertion;
}

export function isSelectedCaseAssertion(assertion: DraftVideoSourceAssertion, handoff: VideoReviewHandoff | undefined) {
  return Boolean(handoff?.claimSnapshots?.some((_, index) => {
    try { return isDeepStrictEqual(assertion, selectedCaseAssertion(handoff, index)); } catch { return false; }
  }));
}

export function assertCaseAmendmentAvailable(job: CreativePortfolioJob) {
  if (!job.snapshot || job.planning.phase !== 'READY_TO_RENDER' || job.videoPreparationVersion !== 1
    || !job.request.reviewHandoff?.choices.frames?.length || job.lease || job.videoCaseAmendment
    || job.previewAcceptanceError || isPreviewTestPortfolio(job)
    || job.slots.some(slot => slot.status !== 'PENDING' || slot.videoSelection || slot.error)) {
    deny('Case amendments require a paused, unrendered ordinary video portfolio. Active, attempted, stopped and saved work is preserved.');
  }
}

/** Validation also runs on saved readback; eligibility is checked separately before applying. */
export function validateCaseAmendment(job: CreativePortfolioJob, value: unknown, requireConfirmation = true): VideoCaseAmendment {
  if (!record(value) || Object.keys(value).length !== 4 || value.version !== 1 || value.intent !== 'VIDEO_CASE_STUDY'
    || !job.snapshot || job.planning.phase !== 'READY_TO_RENDER' || job.videoPreparationVersion !== 1
    || value.baseSnapshotSha256 !== reviewSourceSha256(job.snapshot)
    || !Array.isArray(value.pairs) || value.pairs.length !== job.slots.length || isPreviewTestPortfolio(job)) {
    return deny('Case amendment does not match the original frozen portfolio.');
  }
  const handoff = job.request.reviewHandoff;
  value.pairs.forEach((pair, index) => {
    if (!record(pair) || Object.keys(pair).length !== 4 || pair.slotIndex !== index + 1
      || !Number.isSafeInteger(pair.claimIndex) || Number(pair.claimIndex) < 0 || typeof pair.frameId !== 'string'
      || typeof pair.attributionConfirmed !== 'boolean' || (requireConfirmation && pair.attributionConfirmed !== true)) {
      return deny('Choose a source statement and confirm its person for every creative. Generic copy cannot fulfill a video case amendment.');
    }
    const assertion = selectedCaseAssertion(handoff, Number(pair.claimIndex));
    const frame = handoff!.choices.frames?.find(candidate => candidate.frameId === pair.frameId);
    const context = handoff!.operatorSelectedSourceGuidance.frames?.find(candidate => isDeepStrictEqual(candidate.binding, frame));
    if (!frame || frame.timestampMs < assertion.startMs || frame.timestampMs >= assertion.endMs
      || !context || context.observation?.sceneType !== 'PERSON') {
      return deny('The selected human frame must belong to this statement’s time window and frozen selected pool. Review the person association; substitution is unavailable.');
    }
  });
  return structuredClone(value) as unknown as VideoCaseAmendment;
}

export function proposeCaseAmendment(job: CreativePortfolioJob, pairs: VideoCasePair[]) {
  assertCaseAmendmentAvailable(job);
  const amendment = validateCaseAmendment(job, { version: 1, intent: 'VIDEO_CASE_STUDY',
    baseSnapshotSha256: reviewSourceSha256(job.snapshot), pairs }, false);
  return { amendment, attributionNotice: CASE_ATTRIBUTION_NOTICE,
    creatives: job.slots.map(slot => effectiveCaseConcept({ ...job, videoCaseAmendment: amendment }, slot.index, false)),
    providerOperations: { transcription: 0, planning: 0, audit: 0, maximumFrameAssessments: pairs.length * 2,
      maximumPrimaryImages: pairs.length, fallbackImages: 0 } };
}

/** Derive an overlay while leaving the original paid plan and layout/source snapshots intact. */
export function effectiveCaseConcept(job: CreativePortfolioJob, slotIndex: number, requireConfirmation = true): PlannedCreativeConcept {
  const original = job.snapshot?.batchPlan.creatives[slotIndex - 1];
  if (!original) return deny('Portfolio concept is unavailable.');
  if (!job.videoCaseAmendment) return original;
  const amendment = validateCaseAmendment(job, job.videoCaseAmendment, requireConfirmation);
  const pair = amendment.pairs[slotIndex - 1], assertion = selectedCaseAssertion(job.request.reviewHandoff, pair.claimIndex);
  const concept = structuredClone(original);
  concept.selectionReason = 'Explicit operator video case amendment v1. Exact source wording and person pairing supersede the original copy; the original portfolio audit applies only to its frozen plan.';
  concept.draftSourceAssertion = assertion;
  concept.selectedProof = null;
  concept.adCopy = { headline: 'A video case account', primaryText: assertion.exactText, description: concept.copy.description };
  concept.copy = { ...concept.adCopy };
  concept.imageCopy = { headline: 'One person’s TRA experience', shortSupport: assertion.exactText,
    proofAttribution: 'Supplied video account', cta: original.imageCopy?.cta ?? original.strategy.cta,
    disclosure: original.imageCopy?.disclosure || 'Individual result. Results vary.' };
  delete concept.strategy.approvedHumanId; delete concept.strategy.humanSourceId;
  const subject = `Only the person in selected frame ${pair.frameId}; retain their real likeness. Do not invent, blend or substitute a person.`;
  concept.strategy.execution.subjectSource = 'approved-tra-human';
  concept.strategy.visualDirection = `${subject} Preserve the supplied selected layout blueprint’s composition, region geometry and typography hierarchy. Place the verbatim case account in its text regions; preserve all qualifications and disclosures. Do not recreate source overlays or import people from layout references. If the exact frame is unsuitable, stop instead of substituting.`;
  if (concept.strategy.conceptDetails) concept.strategy.conceptDetails = { ...concept.strategy.conceptDetails,
    mainMessage: assertion.exactText, proposition: assertion.exactText, subject,
    environment: 'Use the source frame environment or a neutral layout background without inventing case details.',
    visualArchetype: 'Selected layout with the supplied video person',
    visualMechanism: 'The exact video person alongside their verbatim source account.',
    compositionInstructions: 'Follow the selected layout blueprint, including portrait and text region placement. Do not replace it with a generic process layout.' };
  return concept;
}

/** Manual selection, hydration and final record checks share this exact one-frame pool. */
export function caseReviewChoices(job: CreativePortfolioJob, slotIndex: number) {
  if (!job.videoCaseAmendment) return job.request.reviewHandoff?.choices;
  const amendment = validateCaseAmendment(job, job.videoCaseAmendment);
  const choices = job.request.reviewHandoff!.choices;
  return { ...choices, frames: choices.frames!.filter(frame => frame.frameId === amendment.pairs[slotIndex - 1].frameId) };
}

/** A source account is not permission to choose any person from a larger manual pool. */
export function caseAssociationNeedsReview(job: CreativePortfolioJob) {
  return !job.videoCaseAmendment && !isPreviewTestPortfolio(job) && Boolean(job.request.reviewHandoff?.choices.frames?.length
    && job.snapshot?.batchPlan.creatives.some(concept => concept.draftSourceAssertion
      && /\b(i|my|me|mine)\b/i.test(concept.draftSourceAssertion.exactText)
      && concept.strategy.execution.subjectSource === 'approved-tra-human'
      && job.slots[concept.index - 1]?.status === 'PENDING'));
}

export function caseAmendmentOptions(job: CreativePortfolioJob) {
  assertCaseAmendmentAvailable(job);
  const video = job.request.reviewHandoff!.choices.video!;
  const plannedPairs = job.slots.map(slot => {
    const assertion = job.snapshot!.batchPlan.creatives[slot.index - 1].draftSourceAssertion;
    const claimIndex = assertion ? job.request.reviewHandoff!.claimSnapshots.findIndex((_, index) => {
      try { return isDeepStrictEqual(assertion, selectedCaseAssertion(job.request.reviewHandoff, index)); }
      catch { return false; }
    }) : -1;
    return { slotIndex: slot.index, claimIndex, frameId: '', attributionConfirmed: false };
  });
  return { plannedPairs, attributionNotice: CASE_ATTRIBUTION_NOTICE, video: { mediaId: video.locator.sourceVideoMediaId,
    libraryId: video.libraryId, sourceVideoContentHash: video.locator.sourceVideoContentHash }, slots: job.slots.map(slot => ({ index: slot.index,
    layoutSource: job.snapshot!.batchPlan.creatives[slot.index - 1].strategy.referenceSelection?.layoutSource ?? null })),
    claims: job.request.reviewHandoff!.claimSnapshots.flatMap((_, claimIndex) => {
      try {
        const assertion = selectedCaseAssertion(job.request.reviewHandoff, claimIndex);
        const frames = job.request.reviewHandoff!.operatorSelectedSourceGuidance.frames?.filter(context =>
          context.binding.timestampMs >= assertion.startMs && context.binding.timestampMs < assertion.endMs
          && context.observation?.sceneType === 'PERSON').map(context => ({ frameId: context.binding.frameId,
            timestampMs: context.binding.timestampMs, observation: context.observation!,
            observationIsExactFrame: context.observationIsExactFrame })) ?? [];
        return frames.length ? [{ claimIndex, wording: assertion.exactText, startMs: assertion.startMs, endMs: assertion.endMs, frames }] : [];
      } catch { return []; }
    }) };
}
