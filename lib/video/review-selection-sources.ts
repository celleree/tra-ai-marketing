import { isDeepStrictEqual } from 'node:util';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { videoCandidateFrameId, type VideoCandidateFrameBinding } from '@/lib/video/generation-selection-contract';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import type { VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import { readVideoIntelligenceSource, resolveExistingVideoIntelligenceJob } from '@/lib/video/intelligence-service';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { listProofRecords } from '@/lib/proof/storage';
import type { ProofRecord } from '@/lib/proof/types';
import { ReviewSelectionError, reviewSourceSha256, type ReviewClaimReference, type ReviewClaimSnapshot,
  type ReviewSelectionChoices, type ReviewVideoReference } from '@/lib/video/review-selection';

export type ReviewVideoSource = { library: VideoFrameLibrary; manifest: VideoIntelligencePreparationManifest };
export type ReviewSourceDependencies = { storage?: VideoIntelligenceStorage; hydrateSource?: (id: string) => Promise<HydratedTraVideoSource> };
const stale = (message: string): never => { throw new ReviewSelectionError(message, 409); };
export const loadReviewVideoSource = async (reference: ReviewVideoReference, dependencies: ReviewSourceDependencies): Promise<ReviewVideoSource> => {
  try {
    const current = await readVideoIntelligenceSource(reference.locator.sourceVideoMediaId,
      { ...dependencies, deadlineAtMs: Date.now() + 55_000 });
    if (!isDeepStrictEqual(current.locator, reference.locator)) stale('Video source or analysis identity changed.');
    const { identity, job } = await resolveExistingVideoIntelligenceJob(reference.locator, dependencies);
    if (job.phase !== 'COMPLETE' || !job.result || !job.preparation) stale('Video analysis is missing or incomplete.');
    if (job.result!.sha256 !== reference.librarySha256 || job.preparation!.manifestSha256 !== reference.preparationSha256) {
      stale('Frozen video library or preparation changed.');
    }
    const [library, prepared] = await Promise.all([
      loadVideoIntelligenceLibrary(identity, job.result!, dependencies),
      loadVideoIntelligencePreparation({ manifestKey: job.preparation!.manifestKey, manifestSha256: reference.preparationSha256,
        expectedSourceVideoMediaId: identity.sourceVideoMediaId, expectedSourceVideoContentHash: identity.sourceVideoContentHash,
        expectedAnalyzerFingerprintSha256: identity.analyzerFingerprint.sha256 }, dependencies),
    ]);
    if (library.id !== reference.libraryId) stale('Video library identity does not match.');
    return { library, manifest: prepared.manifest };
  } catch (error) { return stale(error instanceof Error ? error.message : 'Video source is unavailable.'); }
};
export const loadReviewProofSources = (choices: ReviewSelectionChoices) => choices.claims?.some(claim => claim.type === 'PROOF')
  ? listProofRecords() : Promise.resolve([] as ProofRecord[]);

export const validateReviewFrame = (binding: VideoCandidateFrameBinding, source: ReviewVideoSource) => {
  const { library, manifest } = source;
  const candidate = library.candidates.find(item => item.candidateIndex === binding.candidateIndex);
  const representative = library.representativeFrames.find(item => item.id === binding.representativeFrameId);
  const prepared = manifest.candidates[binding.candidateIndex];
  if (!candidate || !representative || !prepared || !representative.candidateIndexes.includes(binding.candidateIndex)
    || !manifest.groups.some(group => group.representativeIndex === representative.candidateIndex && group.candidateIndexes.includes(binding.candidateIndex))
    || candidate.timestampMs !== binding.timestampMs || candidate.frameSha256 !== binding.frameSha256
    || prepared.timestampMs !== binding.timestampMs || prepared.frameSha256 !== binding.frameSha256
    || binding.frameId !== videoCandidateFrameId(library.sourceVideoContentHash, binding.timestampMs, binding.frameSha256)) {
    stale('Selected frame no longer matches its candidate and technical group.');
  }
};
const excerpt = (text: string | undefined, start: number, end: number) => {
  if (text === undefined || end > text.length || !text.slice(start, end).trim()) stale('Selected source field or text range is missing.');
  return text!.slice(start, end);
};
export const hydrateReviewClaim = (reference: ReviewClaimReference, choices: ReviewSelectionChoices,
  video: ReviewVideoSource | null, proofs: readonly ProofRecord[]): ReviewClaimSnapshot => {
  switch (reference.type) {
    case 'VIDEO_TRANSCRIPT': {
      if (!video) return stale('Selected transcript source is unavailable.');
      const segments = video.library.transcript.segments.slice(reference.startSegmentIndex, reference.endSegmentIndex + 1);
      if (!segments.length || segments.length !== reference.endSegmentIndex - reference.startSegmentIndex + 1
        || segments.some((segment, index) => segment.segmentIndex !== reference.startSegmentIndex + index)) stale('Selected transcript range is missing.');
      // Full expandable context remains in the exact frozen library, not a synthesized claim summary.
      return { reference, wording: segments.map(item => item.text).join(' '), context: { type: reference.type, segments: structuredClone(segments) } };
    }
    case 'VIDEO_ON_SCREEN': {
      if (!video) return stale('Selected on-screen statement source is unavailable.');
      validateReviewFrame(reference.frame, video);
      const frame = video.library.representativeFrames.find(item => item.id === reference.frame.representativeFrameId)!;
      if (frame.candidateIndex !== reference.frame.candidateIndex) stale('This candidate has no source-bound on-screen observation.');
      const wording = frame.observation.visibleText[reference.statementIndex];
      if (!wording?.trim()) stale('Selected on-screen statement is missing.');
      return { reference, wording, context: { type: reference.type, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
        observation: structuredClone(frame.observation) } };
    }
    case 'PROOF': {
      const proof = proofs.find(item => item.id === reference.proofId);
      if (!proof) return stale('Selected Proof record is missing.');
      if (proof.type !== reference.proofType || proof.updatedAt !== reference.proofUpdatedAt || reviewSourceSha256(proof) !== reference.recordSha256) {
        stale('Selected Proof record changed.');
      }
      const text = proof.type === 'review' && reference.field === 'originalReviewText' ? proof.originalReviewText
        : proof.type === 'case-study' && reference.field === 'approvedClaimWording' ? proof.approvedClaimWording
          : proof.type === 'case-study' && reference.field === 'verifiedFacts' ? proof.verifiedFacts[reference.factIndex!] : undefined;
      return { reference, wording: excerpt(text, reference.start, reference.end), context: { type: reference.type, record: structuredClone(proof) } };
    }
    case 'COMPANY_PROFILE': {
      const profile = choices.companyProfile;
      if (!profile) return stale('Selected company-profile snapshot is missing.');
      if (reviewSourceSha256(profile) !== reference.profileSha256) stale('Selected company-profile snapshot changed.');
      const text = profile[reference.section]?.[reference.field];
      return { reference, wording: excerpt(text, reference.start, reference.end), context: { type: reference.type,
        fieldText: text!, guardrails: structuredClone(profile.guardrails ?? {}) } };
    }
  }
};
