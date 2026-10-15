import { hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import { getMediaStorage } from '@/lib/media/local-storage';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { createVideoFrameThumbnailFromBytes } from '@/lib/video/frame-thumbnail';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import { readVideoIntelligenceSource, resolveExistingVideoIntelligenceJob } from '@/lib/video/intelligence-service';
import { ReviewSelectionError, type ReviewVideoReference } from '@/lib/video/review-selection';
import { validateReviewFrame, type ReviewSourceDependencies } from '@/lib/video/review-selection-sources';
import { withVideoCandidateAnalysisImages } from '@/lib/video/selection-context';
import { MAX_REVIEW_PREVIEW_BATCH } from '@/lib/video/review-preview-policy';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';

/** Reads completed work only. Preview JPEGs remain analysis-only, with no pixel approval. */
export const discoverVideoReviewSource = async (mediaId: string, candidateIndexes?: number | readonly number[],
  dependencies: ReviewSourceDependencies = {}) => {
  const indexes = candidateIndexes === undefined ? [] : typeof candidateIndexes === 'number' ? [candidateIndexes] : candidateIndexes;
  if (indexes.length > MAX_REVIEW_PREVIEW_BATCH || new Set(indexes).size !== indexes.length
    || indexes.some(index => !Number.isSafeInteger(index) || index < 0)) {
    throw new ReviewSelectionError('Preview candidate batch is invalid.', 400);
  }
  const current = await readVideoIntelligenceSource(mediaId, { ...dependencies, deadlineAtMs: Date.now() + 55_000 });
  if (current.status?.phase !== 'COMPLETE') {
    if (indexes.length) throw new ReviewSelectionError('Video analysis is not complete.', 409);
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
  const requested = indexes.map(index => {
    const binding = frameBindings.find(item => item.candidateIndex === index);
    if (!binding) throw new ReviewSelectionError('Preview candidate is missing.', 404);
    return binding;
  });
  const previews = requested.filter(binding => library.representativeFrames.some(frame => frame.candidateIndex === binding.candidateIndex))
    .map(binding => ({ binding, providerEligible: false as const,
      thumbnailDataUrl: library.representativeFrames.find(frame => frame.candidateIndex === binding.candidateIndex)!.thumbnailDataUrl }));
  const neighbors = requested.filter(binding => !previews.some(preview => preview.binding.candidateIndex === binding.candidateIndex));
  if (neighbors.length) {
    const source = dependencies.hydrateSource ? await dependencies.hydrateSource(mediaId)
      : (await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId, role: 'TRA_VIDEO' }]))[0] as HydratedTraVideoSource;
    previews.push(...await withVideoCandidateAnalysisImages(source,
      { library, manifest: prepared.manifest, representativeImages: null }, neighbors.map(binding => binding.candidateIndex), async image => {
        const binding = neighbors.find(binding => binding.candidateIndex === image.candidateIndex)!;
        const thumbnail = await createVideoFrameThumbnailFromBytes(prepared.manifest.candidates[image.candidateIndex], image.bytes);
        return { binding, providerEligible: false as const, thumbnailDataUrl: thumbnail.thumbnailDataUrl };
      }));
  }
  return { source: current.source, status: current.status,
    review: { video, library, technicalGroups: prepared.manifest.groups, frameBindings, onScreenStatements,
      preview: typeof candidateIndexes === 'number' ? previews[0] ?? null : null, previews } };
};
