import { hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import { getMediaStorage } from '@/lib/media/local-storage';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { createVideoFrameThumbnailFromBytes } from '@/lib/video/frame-thumbnail';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import { readVideoIntelligenceSource, resolveExistingVideoIntelligenceJob } from '@/lib/video/intelligence-service';
import { ReviewSelectionError, type ReviewVideoReference } from '@/lib/video/review-selection';
import { validateReviewFrame, type ReviewSourceDependencies } from '@/lib/video/review-selection-sources';
import { loadVideoCandidateAnalysisImage } from '@/lib/video/selection-context';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';

/** Reads completed work only. Preview JPEGs remain analysis-only, with no pixel approval. */
export const discoverVideoReviewSource = async (mediaId: string, candidateIndex?: number,
  dependencies: ReviewSourceDependencies = {}) => {
  if (candidateIndex !== undefined && (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0)) {
    throw new ReviewSelectionError('Preview candidate index is invalid.', 400);
  }
  const current = await readVideoIntelligenceSource(mediaId, { ...dependencies, deadlineAtMs: Date.now() + 55_000 });
  if (current.status?.phase !== 'COMPLETE') {
    if (candidateIndex !== undefined) throw new ReviewSelectionError('Video analysis is not complete.', 409);
    return { source: current.source, status: current.status, review: null };
  }
  const { identity, job } = await resolveExistingVideoIntelligenceJob(current.locator, dependencies);
  if (job.phase !== 'COMPLETE' || !job.result || !job.preparation) throw new ReviewSelectionError('Video analysis is not complete.', 409);
  const [library, prepared] = await Promise.all([
    loadVideoIntelligenceLibrary(identity, job.result, dependencies),
    loadVideoIntelligencePreparation({ manifestKey: job.preparation.manifestKey, manifestSha256: job.preparation.manifestSha256,
      expectedSourceVideoMediaId: identity.sourceVideoMediaId, expectedSourceVideoContentHash: identity.sourceVideoContentHash,
      expectedAnalyzerFingerprintSha256: identity.analyzerFingerprint.sha256 }, dependencies),
  ]);
  const video: ReviewVideoReference = { locator: current.locator, libraryId: library.id,
    librarySha256: job.result.sha256, preparationSha256: job.preparation.manifestSha256 };
  const frameBindings = library.candidates.map(candidate => {
    const representative = library.representativeFrames.find(frame => frame.candidateIndexes.includes(candidate.candidateIndex));
    if (!representative) throw new ReviewSelectionError('Candidate technical group is missing.', 409);
    const binding = { frameId: videoCandidateFrameId(library.sourceVideoContentHash, candidate.timestampMs, candidate.frameSha256),
      representativeFrameId: representative.id, candidateIndex: candidate.candidateIndex,
      timestampMs: candidate.timestampMs, frameSha256: candidate.frameSha256 };
    validateReviewFrame(binding, { library, manifest: prepared.manifest });
    return binding;
  });
  // Only the actually observed representative owns its visible text; neighbors have no OCR evidence.
  const onScreenStatements = library.representativeFrames.flatMap(frame => frame.observation.visibleText.flatMap((wording, statementIndex) => {
    const binding = frameBindings.find(item => item.candidateIndex === frame.candidateIndex)!;
    return wording.trim() ? [{ reference: { type: 'VIDEO_ON_SCREEN' as const, frame: binding, statementIndex }, wording,
      context: { type: 'VIDEO_ON_SCREEN' as const, evidenceStatus: frame.evidenceStatus, observation: frame.observation } }] : [];
  }));
  let preview = null;
  if (candidateIndex !== undefined) {
    const binding = frameBindings.find(item => item.candidateIndex === candidateIndex);
    if (!binding) throw new ReviewSelectionError('Preview candidate is missing.', 404);
    const candidate = prepared.manifest.candidates[candidateIndex];
    const representative = library.representativeFrames.find(item => item.candidateIndex === candidateIndex);
    if (representative) {
      preview = { binding, providerEligible: false as const, thumbnailDataUrl: representative.thumbnailDataUrl };
    } else {
      const source = dependencies.hydrateSource ? await dependencies.hydrateSource(mediaId)
        : (await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId, role: 'TRA_VIDEO' }]))[0] as HydratedTraVideoSource;
      const image = await loadVideoCandidateAnalysisImage(source,
        { library, manifest: prepared.manifest, representativeImages: null }, candidateIndex);
      const thumbnail = await createVideoFrameThumbnailFromBytes(candidate, image.bytes);
      preview = { binding, providerEligible: false as const, thumbnailDataUrl: thumbnail.thumbnailDataUrl };
    }
  }
  return { source: current.source, status: current.status,
    review: { video, library, technicalGroups: prepared.manifest.groups, frameBindings, onScreenStatements, preview } };
};
