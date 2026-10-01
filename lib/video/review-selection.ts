import { createHash } from 'node:crypto';
import { COMPANY_PROFILE_STORAGE_KEY, type RuntimeCompanyProfileSnapshot } from '@/lib/company/creative-context';
import { SECTION_FIELDS, type CompanySectionId } from '@/lib/company/profile';
import type { ProofRecord } from '@/lib/proof/types';
import { isProofId } from '@/lib/proof/validation';
import { videoCandidateFrameId, type VideoCandidateFrameBinding } from '@/lib/video/generation-selection-contract';
import type { VideoIntelligenceJobLocator } from '@/lib/video/intelligence-service';
import type { VideoTranscriptSegment } from '@/lib/video/transcript';
import type { FrameVisualObservation } from '@/lib/video/visual-observation';

export type ReviewVideoReference = { locator: VideoIntelligenceJobLocator; libraryId: string;
  librarySha256: string; preparationSha256: string };
type TextRange = { start: number; end: number };
export type ReviewClaimReference =
  | { type: 'VIDEO_TRANSCRIPT'; startSegmentIndex: number; endSegmentIndex: number }
  | { type: 'VIDEO_ON_SCREEN'; frame: VideoCandidateFrameBinding; statementIndex: number }
  | ({ type: 'PROOF'; proofId: string; proofType: ProofRecord['type']; proofUpdatedAt: string;
      recordSha256: string; field: 'originalReviewText' | 'approvedClaimWording' | 'verifiedFacts'; factIndex: number | null } & TextRange)
  | ({ type: 'COMPANY_PROFILE'; profileVersion: typeof COMPANY_PROFILE_STORAGE_KEY; profileSha256: string;
      section: CompanySectionId; field: string } & TextRange);
/** null = untouched; [] = explicitly deselected. Both keep automatic frame selection available. */
export type ReviewSelectionChoices = { video: ReviewVideoReference | null; frames: VideoCandidateFrameBinding[] | null;
  claims: ReviewClaimReference[] | null; companyProfile: RuntimeCompanyProfileSnapshot | null };
export type ReviewClaimSnapshot = { reference: ReviewClaimReference; wording: string; context:
  | { type: 'VIDEO_TRANSCRIPT'; segments: VideoTranscriptSegment[] }
  | { type: 'VIDEO_ON_SCREEN'; evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION'; observation: FrameVisualObservation }
  | { type: 'PROOF'; record: ProofRecord }
  | { type: 'COMPANY_PROFILE'; fieldText: string; guardrails: RuntimeCompanyProfileSnapshot['guardrails'] } };
/** Draft guidance only: no overlay assessment, generation PNGs, or advertising approval. */
export type VideoReviewDraft = { version: 1; artifactType: 'VIDEO_REVIEW_DRAFT'; providerEligible: false;
  id: string; choices: ReviewSelectionChoices; claimSnapshots: ReviewClaimSnapshot[]; updatedAtMs: number };
export class ReviewSelectionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}
export const reviewSourceSha256 = (value: unknown): string => {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
};
export const usesAutomaticReviewFrames = (choices: ReviewSelectionChoices) => !choices.frames?.length;
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const index = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const range = (value: Record<string, unknown>) => index(value.start) && index(value.end) && Number(value.end) > Number(value.start);
const frame = (value: unknown, sourceHash: string) => record(value)
  && exact(value, ['frameId', 'representativeFrameId', 'candidateIndex', 'timestampMs', 'frameSha256'])
  && typeof value.representativeFrameId === 'string' && /^video-frame:[a-f0-9]{64}$/.test(value.representativeFrameId)
  && index(value.candidateIndex) && index(value.timestampMs) && sha(value.frameSha256)
  && value.frameId === videoCandidateFrameId(sourceHash, Number(value.timestampMs), String(value.frameSha256));
const video = (value: unknown) => record(value) && exact(value, ['locator', 'libraryId', 'librarySha256', 'preparationSha256'])
  && record(value.locator) && exact(value.locator, ['version', 'sourceVideoMediaId', 'sourceVideoContentHash', 'analyzerFingerprintSha256'])
  && value.locator.version === 1 && typeof value.locator.sourceVideoMediaId === 'string'
  && /^media_[a-f0-9]{32}$/.test(value.locator.sourceVideoMediaId) && sha(value.locator.sourceVideoContentHash)
  && sha(value.locator.analyzerFingerprintSha256) && typeof value.libraryId === 'string' && /^video-library:[a-f0-9]{64}$/.test(value.libraryId)
  && sha(value.librarySha256) && sha(value.preparationSha256);
const profile = (value: unknown) => record(value) && Object.entries(value).every(([key, section]) => key === 'websiteUrl'
  ? typeof section === 'string' && section.length <= 2048
  : Object.hasOwn(SECTION_FIELDS, key) && record(section) && Object.entries(section).every(([field, text]) =>
    SECTION_FIELDS[key as CompanySectionId].some(item => item.key === field) && typeof text === 'string' && text.length <= 12_000));
const claim = (value: unknown, sourceHash: string) => {
  if (!record(value)) return false;
  switch (value.type) {
    case 'VIDEO_TRANSCRIPT': return exact(value, ['type', 'startSegmentIndex', 'endSegmentIndex'])
      && index(value.startSegmentIndex) && index(value.endSegmentIndex) && Number(value.endSegmentIndex) >= Number(value.startSegmentIndex);
    case 'VIDEO_ON_SCREEN': return exact(value, ['type', 'frame', 'statementIndex']) && frame(value.frame, sourceHash) && index(value.statementIndex);
    case 'PROOF': return exact(value, ['type', 'proofId', 'proofType', 'proofUpdatedAt', 'recordSha256', 'field', 'factIndex', 'start', 'end'])
      && isProofId(value.proofId) && ['review', 'case-study'].includes(String(value.proofType)) && typeof value.proofUpdatedAt === 'string'
      && Number.isFinite(Date.parse(value.proofUpdatedAt)) && sha(value.recordSha256) && range(value)
      && (value.field === 'verifiedFacts' ? index(value.factIndex) : value.factIndex === null)
      && ['originalReviewText', 'approvedClaimWording', 'verifiedFacts'].includes(String(value.field));
    case 'COMPANY_PROFILE': return exact(value, ['type', 'profileVersion', 'profileSha256', 'section', 'field', 'start', 'end'])
      && value.profileVersion === COMPANY_PROFILE_STORAGE_KEY && sha(value.profileSha256) && range(value)
      && typeof value.section === 'string' && Object.hasOwn(SECTION_FIELDS, value.section) && typeof value.field === 'string'
      && SECTION_FIELDS[value.section as CompanySectionId].some(item => item.key === value.field);
    default: return false;
  }
};
export const parseReviewSelectionChoices = (value: unknown): ReviewSelectionChoices => {
  if (!record(value) || !exact(value, ['video', 'frames', 'claims', 'companyProfile']) || (value.video !== null && !video(value.video))
    || (value.companyProfile !== null && !profile(value.companyProfile))) throw new ReviewSelectionError('Review selection sources are invalid.', 400);
  const sourceHash = (value.video as ReviewVideoReference | null)?.locator.sourceVideoContentHash ?? '';
  if ((value.frames !== null && (!Array.isArray(value.frames) || value.frames.length > 3 || value.frames.some(item => !frame(item, sourceHash))
    || new Set(value.frames.map(item => item.frameId)).size !== value.frames.length))
    || (value.claims !== null && (!Array.isArray(value.claims) || value.claims.length > 50 || value.claims.some(item => !claim(item, sourceHash))
      || new Set(value.claims.map(reviewSourceSha256)).size !== value.claims.length))
    || (!value.video && ((value.frames as unknown[] | null)?.length || (value.claims as ReviewClaimReference[] | null)?.some(item => item.type.startsWith('VIDEO_'))))) {
    throw new ReviewSelectionError('Select at most three distinct frames and fifty distinct source claims.', 400);
  }
  return structuredClone(value) as ReviewSelectionChoices;
};
