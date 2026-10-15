import { MAX_CREATIVE_SOURCE_ASSETS } from '@/lib/media/source-limits';
import type { RuntimeCompanyProfileSnapshot } from '@/lib/company/creative-context';
import { loadVideoReviewDraftWithFrameContext } from '@/lib/video/review-selection-store';
import type { ReviewSourceDependencies } from '@/lib/video/review-selection-sources';
import { isDeepStrictEqual } from 'node:util';
import { parseReviewSelectionChoices, record, ReviewSelectionError, reviewSourceSha256, usesAutomaticReviewFrames } from '@/lib/video/review-selection';

export type VideoReviewReference = { draftId: string; revision: string };
export type ReviewHandoffInput = VideoReviewReference & {
  traVideoMediaIds: readonly string[];
  currentCompanyProfile?: RuntimeCompanyProfileSnapshot | null;
};
export const MAX_REVIEW_HANDOFF_BYTES = 512 * 1024;
export const MAX_OPERATOR_SOURCE_GUIDANCE_BYTES = 128 * 1024;
type LoadedReview = Awaited<ReturnType<typeof loadVideoReviewDraftWithFrameContext>>;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
const immutable = <T>(value: T): DeepReadonly<T> => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
};
const requireSize = (value: unknown, limit: number, label: string) => {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) {
    throw new ReviewSelectionError(`${label} exceeds ${limit} bytes. Select fewer statements/frames or a shorter exact source range; no selected material was truncated.`, 400);
  }
};

/** One adjacent segment on each side; selected segments are never clipped or dropped. */
const selectedTranscriptContext = (loaded: LoadedReview) => {
  const transcript = loaded.transcriptContext;
  if (!transcript) return null;
  const indexes = new Set<number>();
  for (const claim of loaded.draft.claimSnapshots) if (claim.context.type === 'VIDEO_TRANSCRIPT') {
    const segments = claim.context.segments;
    segments.forEach(segment => indexes.add(segment.segmentIndex));
    indexes.add(segments[0].segmentIndex - 1);
    indexes.add(segments.at(-1)!.segmentIndex + 1);
  }
  const timestamps = [...(loaded.draft.choices.frames ?? []).map(frame => frame.timestampMs),
    ...loaded.draft.claimSnapshots.flatMap(claim => claim.reference.type === 'VIDEO_ON_SCREEN' ? [claim.reference.frame.timestampMs] : [])];
  for (const timestamp of timestamps) {
    const segment = transcript.segments.find(item => item.startMs <= timestamp && timestamp < item.endMs);
    if (segment) for (const offset of [-1, 0, 1]) indexes.add(segment.segmentIndex + offset);
  }
  const segments = transcript.segments.filter(segment => indexes.has(segment.segmentIndex));
  return { ...transcript, segments, surroundingSegmentRadius: 1 as const,
    totalSourceSegments: transcript.segments.length, omittedSegments: transcript.segments.length - segments.length };
};

/** Server foundation only. The existing store owns all source hydration/validation; no provider work. */
export async function resolveVideoReviewHandoff(input: ReviewHandoffInput, dependencies: ReviewSourceDependencies = {}) {
  if (!/^review_[a-f0-9]{32}$/.test(input.draftId) || typeof input.revision !== 'string'
    || !input.revision.trim() || input.revision.length > 1024 || !Array.isArray(input.traVideoMediaIds)
    || input.traVideoMediaIds.length > MAX_CREATIVE_SOURCE_ASSETS
    || input.traVideoMediaIds.some(id => typeof id !== 'string' || !/^media_[a-f0-9]{32}$/.test(id))
    || new Set(input.traVideoMediaIds).size !== input.traVideoMediaIds.length) {
    throw new ReviewSelectionError('Supply a valid saved review ID/revision and distinct TRA_VIDEO media IDs.', 400);
  }
  const loaded = await loadVideoReviewDraftWithFrameContext(input.draftId, dependencies,
    input.currentCompanyProfile === undefined ? undefined : reviewSourceSha256(input.currentCompanyProfile));
  if (loaded.revision !== input.revision) throw new ReviewSelectionError('Review draft changed. Reload the saved review before generating.', 409);
  if (loaded.issues.length) throw new ReviewSelectionError(`Saved review sources require attention: ${loaded.issues.map(issue => issue.message).join(' ')}`, 409);
  const { choices, claimSnapshots } = loaded.draft;
  if (choices.video && !input.traVideoMediaIds.includes(choices.video.locator.sourceVideoMediaId)) {
    throw new ReviewSelectionError('The reviewed video must be supplied as a TRA_VIDEO source. Restore it or update the saved review.', 409);
  }
  const operatorSelectedSourceGuidance = structuredClone({
    usage: 'DRAFT_CREATIVE_GUIDANCE_ONLY' as const, grantsAdvertisingApproval: false as const, providerEligible: false as const,
    video: choices.video, frameMode: usesAutomaticReviewFrames(choices) ? 'AUTOMATIC' as const : 'MANUAL_CLOSED_POOL' as const,
    frames: loaded.selectedFrameContexts, statements: choices.claims === null ? null : claimSnapshots,
    transcriptContext: selectedTranscriptContext(loaded), companyProfile: choices.companyProfile,
  });
  const value = structuredClone({ version: 1 as const, artifactType: 'VIDEO_REVIEW_HANDOFF' as const,
    draftId: loaded.draft.id, revision: loaded.revision, choices, claimSnapshots, operatorSelectedSourceGuidance });
  const handoff = { ...value, handoffSha256: reviewSourceSha256(value) };
  requireSize(handoff, MAX_REVIEW_HANDOFF_BYTES, 'Review handoff');
  requireSize(operatorSelectedSourceGuidance, MAX_OPERATOR_SOURCE_GUIDANCE_BYTES, 'Selected source guidance');
  return immutable(handoff);
}
export type VideoReviewHandoff = Awaited<ReturnType<typeof resolveVideoReviewHandoff>>;

/** Validate frozen saved input without consulting a subsequently edited review draft. */
export function validateStoredReviewHandoff(value: unknown, reference: VideoReviewReference | undefined, videoIds: readonly string[]) {
  if (value === undefined) return reference === undefined;
  try {
    if (!record(value) || !reference || value.version !== 1 || value.artifactType !== 'VIDEO_REVIEW_HANDOFF'
      || value.draftId !== reference.draftId || value.revision !== reference.revision) return false;
    const { handoffSha256, ...snapshot } = value;
    if (handoffSha256 !== reviewSourceSha256(snapshot)) return false;
    requireSize(value, MAX_REVIEW_HANDOFF_BYTES, 'Review handoff');
    const choices = parseReviewSelectionChoices(value.choices), guidance = value.operatorSelectedSourceGuidance;
    requireSize(guidance, MAX_OPERATOR_SOURCE_GUIDANCE_BYTES, 'Selected source guidance');
    return (!choices.video || videoIds.includes(choices.video.locator.sourceVideoMediaId)) && record(guidance)
      && guidance.usage === 'DRAFT_CREATIVE_GUIDANCE_ONLY' && guidance.grantsAdvertisingApproval === false && guidance.providerEligible === false
      && isDeepStrictEqual(guidance.video, choices.video) && isDeepStrictEqual(guidance.companyProfile, choices.companyProfile)
      && guidance.frameMode === (usesAutomaticReviewFrames(choices) ? 'AUTOMATIC' : 'MANUAL_CLOSED_POOL')
      && isDeepStrictEqual(Array.isArray(guidance.frames) ? guidance.frames.map(item => item.binding) : guidance.frames, choices.frames)
      && Array.isArray(value.claimSnapshots) && value.claimSnapshots.length === (choices.claims?.length ?? 0)
      && value.claimSnapshots.every((claim, index) => record(claim) && typeof claim.wording === 'string' && record(claim.context)
        && isDeepStrictEqual(claim.reference, choices.claims![index]))
      && isDeepStrictEqual(guidance.statements, choices.claims === null ? null : value.claimSnapshots);
  } catch { return false; }
}

/** Final saved/attached frame identities must remain inside the operator's frozen pool. */
export function assertReviewedFrameSelection(choices: VideoReviewHandoff['choices'] | undefined,
  selection: import('@/lib/video/generation-selection-contract').GenerateVideoFrameSelection
    | import('@/lib/video/generation-selection-contract').GeneratedVideoFrameSelection | undefined) {
  if (!choices?.frames?.length) return;
  const video = choices.video;
  const bindings = selection && ('frames' in selection ? selection.frames.map(frame => ({
    frameId: frame.libraryFrameId, representativeFrameId: frame.representativeFrameId,
    candidateIndex: frame.candidateIndex, timestampMs: frame.timestampMs, frameSha256: frame.candidateFrameSha256,
  })) : selection.version === 3 ? selection.candidateBindings : undefined);
  if (!video || !selection || selection.libraryId !== video.libraryId || selection.librarySha256 !== video.librarySha256
    || selection.sourceVideoMediaId !== video.locator.sourceVideoMediaId
    || selection.sourceVideoContentHash !== video.locator.sourceVideoContentHash
    || !bindings?.length || bindings.some(binding => !choices.frames!.some(allowed => isDeepStrictEqual(binding, allowed)))) {
    throw new ReviewSelectionError('Manual closed-pool frame selection does not match the frozen review. Automatic substitution is unavailable.', 409);
  }
}
