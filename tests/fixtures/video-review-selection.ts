import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { COMPANY_PROFILE_STORAGE_KEY } from '@/lib/company/creative-context';
import { reviewSourceSha256, type ReviewClaimReference, type ReviewSelectionChoices } from '@/lib/video/review-selection';

export const locator = { version: 1 as const, sourceVideoMediaId: `media_${'a'.repeat(32)}`, sourceVideoContentHash: 'b'.repeat(64), analyzerFingerprintSha256: 'c'.repeat(64) };
export const frame = (candidateIndex: number) => ({ frameId: videoCandidateFrameId(locator.sourceVideoContentHash, candidateIndex * 1000, 'd'.repeat(64)),
  representativeFrameId: videoCandidateFrameId(locator.sourceVideoContentHash, 0, 'd'.repeat(64)), candidateIndex,
  timestampMs: candidateIndex * 1000, frameSha256: 'd'.repeat(64) });
export const video = { locator, libraryId: `video-library:${'e'.repeat(64)}`, librarySha256: 'f'.repeat(64), preparationSha256: '1'.repeat(64) };
export const segments = [{ segmentIndex: 0, startMs: 0, endMs: 1000, text: 'A free consultation is available.' },
  { segmentIndex: 1, startMs: 1000, endMs: 2000, text: 'Eligibility and fees vary by state.' }];
export const library = { id: video.libraryId, sourceVideoMediaId: locator.sourceVideoMediaId, sourceVideoContentHash: locator.sourceVideoContentHash,
  transcript: { version: 1, model: 'whisper-1', language: 'en', segments },
  candidates: [frame(0), frame(1)], representativeFrames: [{ id: frame(0).frameId, candidateIndex: 0, candidateIndexes: [0, 1],
    observation: { sceneType: 'PROOF_GRAPHIC', visibleText: ['Free consultation', 'Eligibility varies.'],
      summary: 'A display summary is not a claim.', composition: 'Text on a background.', topics: ['on-screen text'], uncertainties: ['Small print unclear.'] } }] };
export const manifest = { candidates: [frame(0), frame(1)], groups: [{ representativeIndex: 0, candidateIndexes: [0, 1] }] };
export const review = { id: `proof_${'2'.repeat(32)}`, type: 'review' as const, tags: [], status: 'INACTIVE' as const,
  advertisingUseApproved: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  originalReviewText: 'The team explained the next step. My result is specific to my case.', source: 'Uploaded review' };
export const caseStudy = { id: `proof_${'3'.repeat(32)}`, type: 'case-study' as const, tags: [], status: 'INACTIVE' as const,
  advertisingUseApproved: false, createdAt: review.createdAt, updatedAt: review.updatedAt,
  title: 'A documented case', verifiedFacts: ['One specific case was resolved.'], approvedClaimWording: 'A specific documented result.',
  sourceNote: 'TRA case record', usageRestrictions: 'Do not generalize.', requiredDisclaimer: 'Results vary.' };
export const profile = { knowledgeBase: { servicesOffers: 'Free consultation. Fees vary by state.' }, guardrails: { requiredDisclaimers: 'Eligibility varies.' } };
export const proofChoice = (proof = review, field = 'originalReviewText'): ReviewClaimReference => ({ type: 'PROOF', proofId: proof.id,
  proofType: proof.type, proofUpdatedAt: proof.updatedAt, recordSha256: reviewSourceSha256(proof), field: field as 'originalReviewText',
  factIndex: null, start: 0, end: field === 'originalReviewText' ? review.originalReviewText.length : caseStudy.approvedClaimWording.length });
export const claims = (): ReviewClaimReference[] => [
  { type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 1 },
  { type: 'VIDEO_ON_SCREEN', frame: frame(0), statementIndex: 0 }, proofChoice(),
  proofChoice(caseStudy as never, 'approvedClaimWording'),
  { type: 'COMPANY_PROFILE', profileVersion: COMPANY_PROFILE_STORAGE_KEY, profileSha256: reviewSourceSha256(profile),
    section: 'knowledgeBase', field: 'servicesOffers', start: 0, end: 18 },
];
export const choices = (): ReviewSelectionChoices => ({ video, frames: [frame(0), frame(1)], claims: claims(), companyProfile: profile });
export const blank = (): ReviewSelectionChoices => ({ video: null, frames: null, claims: null, companyProfile: null });
