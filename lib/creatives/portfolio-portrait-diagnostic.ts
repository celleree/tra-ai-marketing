import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { caseReviewChoices } from '@/lib/creatives/portfolio-case-amendment';
import { providerPortraitIdentity } from '@/lib/video/provider-portrait';
import { readCandidateSuitability } from '@/lib/video/candidate-suitability';
import { hydratePlanningSourceInventory } from '@/lib/creatives/generation-sources';
import { hydratePortfolioVideoFrameSelection } from '@/lib/creatives/portfolio-video-selection';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';

/** All persistent operations are reads. The preview is the exact pinned PNG, never a new assessment. */
export async function portfolioPortraitDiagnostic(job: CreativePortfolioJob, slotIndex: number,
  storage: VideoIntelligenceStorage = getVideoIntelligenceStorage()) {
  const slot = job.slots.find(slot => slot.index === slotIndex), selected = slot?.videoSelection;
  if (job.lease || !job.videoCaseAmendment || selected?.version !== 2 || !selected.selection || !selected.providerPortrait) {
    throw new Error('A paused saved case with a pinned portrait is required.');
  }
  const state = selected.providerPortrait, selection = selected.selection, choices = caseReviewChoices(job, slotIndex);
  const binding = selection.candidateBindings![0], caseFrame = choices!.frames![0];
  if (!caseFrame || caseFrame.frameId !== binding.frameId || caseFrame.timestampMs !== binding.timestampMs) {
    throw new Error('The saved portrait differs from the confirmed case frame.');
  }
  const assessment = await readCandidateSuitability(providerPortraitIdentity(selection, state, selected.selectionModel), { storage, deadlineAtMs: Date.now() });
  const result = {
    portfolioId: job.id, frameIdentity: { selectedFrameId: binding.frameId, selectedCandidateIndex: binding.candidateIndex,
      caseFrameId: caseFrame.frameId, caseTimestampMs: caseFrame.timestampMs },
    cropDecision: selection.sourceOverlays![0],
    originalDimensions: null as null | { width: number; height: number },
    originalPng: null as null | { dataUrl: string; width: number; height: number },
    originalPreviewError: '',
    slotIndex, timestampMs: selection.candidateBindings![0].timestampMs, crop: state.crop,
    assessmentStatus: assessment.status,
    assessment: assessment.status === 'COMPLETE' ? assessment.assessment : null,
    failedChecks: assessment.status !== 'COMPLETE' ? [] : Object.entries(assessment.assessment).filter(([field, value]) => {
      const expected: Record<string, string> = { humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE',
        occlusion: 'NONE_OR_MINOR', expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE' };
      return field in expected ? value !== expected[field] : field === 'blur' ? value === 'SEVERE'
        : field === 'sourceOverlay' ? assessment.assessment.sourceOverlay.status !== 'CLEAN' : false;
    }).map(([field]) => field),
    png: null as null | { dataUrl: string; width: number; height: number; matchesPinned: true },
    previewError: '' as string,
  };
  try {
    if (!job.snapshot?.sourceAnalysis) throw new Error('Frozen source preparation is unavailable.');
    const inventory = await hydratePlanningSourceInventory(job.request.sourceAssets.filter(source =>
      source.role === 'TRA_VIDEO' && source.mediaId === selection.sourceVideoMediaId));
    const extracted = await hydratePortfolioVideoFrameSelection({ sourceAnalysis: job.snapshot.sourceAnalysis,
      sources: inventory.map(item => item.source as HydratedTraVideoSource), selection, reviewChoices: choices });
    const frame = extracted.frames[0];
    if (extracted.frames.length !== 1 || createHash('sha256').update(frame.buffer).digest('hex') !== state.sourcePngSha256) {
      throw new Error('The original PNG differs from the pinned source.');
    }
    const originalMetadata = await sharp(frame.buffer).metadata();
    result.originalDimensions = { width: originalMetadata.width!, height: originalMetadata.height! };
    const [prepared] = await prepareProviderVideoFrames([{ ...frame, expectedProviderPngSha256: state.providerPngSha256, expectedCrop: state.crop }]);
    // Keep the inline response below function response limits without changing the inspected pixels.
    if (prepared.providerBuffer.length > 2_500_000) throw new Error('Pinned PNG is too large for inline preview.');
    const metadata = await sharp(prepared.providerBuffer).metadata();
    result.png = { dataUrl: `data:image/png;base64,${prepared.providerBuffer.toString('base64')}`,
      width: metadata.width!, height: metadata.height!, matchesPinned: true };
    // Share the existing inline byte budget. Never resize/substitute either evidence image.
    if (frame.buffer.length + prepared.providerBuffer.length <= 2_500_000) {
      result.originalPng = { dataUrl: `data:image/png;base64,${frame.buffer.toString('base64')}`, ...result.originalDimensions };
    } else result.originalPreviewError = 'The uncropped PNG exceeds the shared inline preview limit. Its verified dimensions are shown; no resized image was substituted.';
  } catch {
    result.previewError = 'The exact pinned PNG could not be displayed. Cached assessment and crop are shown; no pixels were substituted or reassessed.';
  }
  return result;
}
