import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getVideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { hydrateReviewClaim, loadReviewProofSources, loadReviewVideoSource, validateReviewFrame,
  type ReviewSourceDependencies } from '@/lib/video/review-selection-sources';
import { parseReviewSelectionChoices, record, ReviewSelectionError, reviewSourceSha256, type VideoReviewDraft } from '@/lib/video/review-selection';

const MAX_BYTES = 1024 * 1024;
export type ReviewSelectionIssue = { source: 'VIDEO' | 'CLAIM' | 'COMPANY_PROFILE'; index?: number; message: string };
const key = (id: string) => {
  if (!/^review_[a-f0-9]{32}$/.test(id)) throw new ReviewSelectionError('Review draft ID is invalid.', 400);
  return `review-drafts/v1/${id}.json`;
};
const readStored = async (id: string, dependencies: ReviewSourceDependencies) => {
  const stored = await (dependencies.storage ?? getVideoIntelligenceStorage()).read(key(id));
  if (!stored) return null;
  if (stored.bytes.length > MAX_BYTES) throw new Error('Review draft exceeds its size limit.');
  const draft = JSON.parse(stored.bytes.toString('utf8')) as VideoReviewDraft;
  if (!record(draft) || draft.version !== 1 || draft.artifactType !== 'VIDEO_REVIEW_DRAFT' || draft.providerEligible !== false
    || draft.id !== id || !Number.isSafeInteger(draft.updatedAtMs) || !Array.isArray(draft.claimSnapshots)) throw new Error('Stored review draft is invalid.');
  draft.choices = parseReviewSelectionChoices(draft.choices);
  if (draft.claimSnapshots.length !== (draft.choices.claims?.length ?? 0) || draft.claimSnapshots.some((snapshot, index) =>
    !record(snapshot) || typeof snapshot.wording !== 'string' || !record(snapshot.context)
    || !isDeepStrictEqual(snapshot.reference, draft.choices.claims![index]))) throw new Error('Stored review claims are invalid.');
  return { draft, revision: stored.etag };
};
export const saveVideoReviewDraft = async (input: { id: string | null; expectedRevision: string | null; choices: unknown },
  dependencies: ReviewSourceDependencies = {}) => {
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !input.expectedRevision)) {
    throw new ReviewSelectionError('Review revision is invalid.', 400);
  }
  const choices = parseReviewSelectionChoices(input.choices);
  const id = input.id ?? `review_${randomUUID().replaceAll('-', '')}`;
  const current = await readStored(id, dependencies);
  if ((current?.revision ?? null) !== input.expectedRevision) throw new ReviewSelectionError('Review draft changed. Reload before saving.', 409);
  const [video, proofs] = await Promise.all([choices.video ? loadReviewVideoSource(choices.video, dependencies) : null, loadReviewProofSources(choices)]);
  choices.frames?.forEach(binding => validateReviewFrame(binding, video!));
  const claimSnapshots = choices.claims?.map(reference => hydrateReviewClaim(reference, choices, video, proofs)) ?? [];
  const draft: VideoReviewDraft = { version: 1, artifactType: 'VIDEO_REVIEW_DRAFT', providerEligible: false,
    id, choices, claimSnapshots, updatedAtMs: Math.max(Date.now(), (current?.draft.updatedAtMs ?? -1) + 1) };
  const bytes = Buffer.from(JSON.stringify(draft));
  if (bytes.length > MAX_BYTES) throw new ReviewSelectionError('Review draft exceeds its size limit.', 400);
  const storage = dependencies.storage ?? getVideoIntelligenceStorage();
  if (!await storage.write(key(id), bytes, input.expectedRevision)) throw new ReviewSelectionError('Review draft changed. Reload before saving.', 409);
  // Read back the storage revision without substituting a concurrent writer's draft.
  const saved = await storage.read(key(id));
  if (!saved || !saved.bytes.equals(bytes)) throw new ReviewSelectionError('Review draft changed after saving. Reload it.', 409);
  return { draft, revision: saved.etag, issues: [] as ReviewSelectionIssue[],
    transcriptContext: video?.library.transcript ?? null, profileSource: choices.companyProfile ? 'OPERATOR_SNAPSHOT' as const : null };
};
export const loadVideoReviewDraft = async (id: string, dependencies: ReviewSourceDependencies = {}, currentProfileSha256?: string) => {
  const saved = await readStored(id, dependencies);
  if (!saved) throw new ReviewSelectionError('Review draft was not found.', 404);
  const { choices } = saved.draft; const issues: ReviewSelectionIssue[] = [];
  const video = choices.video ? await loadReviewVideoSource(choices.video, dependencies).catch(error => {
    issues.push({ source: 'VIDEO', message: error instanceof Error ? error.message : 'Video source is unavailable.' }); return null;
  }) : null;
  const proofs = await loadReviewProofSources(choices);
  if (video) choices.frames?.forEach((binding, index) => { try { validateReviewFrame(binding, video); }
    catch (error) { issues.push({ source: 'VIDEO', index, message: (error as Error).message }); } });
  choices.claims?.forEach((reference, index) => { try {
    const current = hydrateReviewClaim(reference, choices, video, proofs);
    if (!isDeepStrictEqual(current, saved.draft.claimSnapshots[index])) throw new ReviewSelectionError('Selected source context changed.', 409);
  } catch (error) { issues.push({ source: 'CLAIM', index, message: (error as Error).message }); } });
  if (currentProfileSha256 !== undefined && choices.companyProfile && currentProfileSha256 !== reviewSourceSha256(choices.companyProfile)) {
    issues.push({ source: 'COMPANY_PROFILE', message: 'Current browser profile differs from the saved operator snapshot.' });
  }
  return { ...saved, issues, transcriptContext: video?.library.transcript ?? null,
    profileSource: choices.companyProfile ? 'OPERATOR_SNAPSHOT' as const : null };
};
