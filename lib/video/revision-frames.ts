import { createHash } from 'node:crypto';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import {
  parseGeneratedVideoFrameSelection,
  type GeneratedVideoFrameSelection,
} from '@/lib/video/generation-selection-contract';
import { extractVideoSelectionFrames, loadVideoSelectionContext } from '@/lib/video/selection-context';
import { getApprovedTraVideoFrames } from '@/lib/video/tra-video-frames';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

type SavedVideoSource = Extract<
  CreativeGenerationProvenance['attachedSource'],
  { type: 'TRA_VIDEO_FRAMES' }
>;

const SHA256 = /^[a-f0-9]{64}$/;

const sha256 = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

const isHydratedTraVideo = (
  source: HydratedCreativeSourceAsset
): source is HydratedTraVideoSource =>
  source.role === 'TRA_VIDEO' &&
  source.media.mediaType === 'VIDEO' &&
  source.media.mimeType === 'video/mp4' &&
  source.stored.mediaType === 'VIDEO' &&
  source.stored.mimeType === 'video/mp4';

const validateSavedSource = (
  source: HydratedCreativeSourceAsset,
  attachedSource: SavedVideoSource
): HydratedTraVideoSource => {
  if (!isHydratedTraVideo(source)) {
    throw new Error('Revision video frames require a server-hydrated TRA_VIDEO MP4.');
  }
  if (
    source.media.id !== attachedSource.mediaId ||
    sha256(source.stored.buffer) !== attachedSource.sourceSha256
  ) {
    throw new Error('The saved TRA video source has changed or does not match this creative.');
  }
  if (
    attachedSource.frames.length < 1 ||
    attachedSource.frames.length > 3 ||
    attachedSource.frames.some(
      (frame) =>
        !Number.isSafeInteger(frame.timestampMs) ||
        frame.timestampMs < 0 ||
        !SHA256.test(frame.approvedPngSha256)
    ) ||
    new Set(
      attachedSource.frames.map(
        (frame) => `${frame.timestampMs}:${frame.approvedPngSha256}`
      )
    ).size !== attachedSource.frames.length
  ) {
    throw new Error('The saved TRA video frame provenance is invalid.');
  }
  return source;
};

const verifyFrame = (
  frame: ApprovedTraVideoFrame,
  source: HydratedTraVideoSource,
  sourceHash: string
) => {
  const bufferHash = sha256(frame.buffer);
  if (
    frame.mimeType !== 'image/png' ||
    frame.sourceRole !== 'TRA_VIDEO' ||
    frame.sourceVideoMediaId !== source.media.id ||
    frame.sourceVideoContentHash !== sourceHash ||
    frame.approvedHumanSource !== true ||
    frame.frameSha256 !== bufferHash ||
    frame.byteLength !== frame.buffer.length
  ) {
    throw new Error('An approved TRA video frame failed revision integrity validation.');
  }
  return bufferHash;
};

const exactSavedSubset = (
  frames: ApprovedTraVideoFrame[],
  saved: SavedVideoSource['frames'],
  source: HydratedTraVideoSource,
  sourceHash: string
) => {
  const unused = frames.map((frame, index) => ({
    frame,
    index,
    hash: verifyFrame(frame, source, sourceHash),
  }));
  const used = new Set<number>();
  return saved.map((expected) => {
    const match = unused.find(
      ({ frame, index, hash }) =>
        !used.has(index) &&
        frame.timestampMs === expected.timestampMs &&
        hash === expected.approvedPngSha256
    );
    if (!match) {
      throw new Error(
        'The saved TRA video frame no longer matches approved PNG pixels. Reanalyze the video before revising this creative.'
      );
    }
    used.add(match.index);
    if (!expected.sourceOverlay || !expected.providerPngSha256 || expected.crop === undefined) {
      throw new Error('This creative predates source-overlay assessment. Start a new creative with an assessed human frame before revising.');
    }
    return { ...match.frame, sourceOverlay: expected.sourceOverlay,
      expectedProviderPngSha256: expected.providerPngSha256, expectedCrop: expected.crop };
  });
};

export async function resolveRevisionVideoFrames(
  source: HydratedCreativeSourceAsset,
  attachedSource: SavedVideoSource,
  selection?: GeneratedVideoFrameSelection
): Promise<ApprovedTraVideoFrame[]> {
  const video = validateSavedSource(source, attachedSource);

  if (attachedSource.selectionMode === 'AUTOMATIC' && selection === undefined) {
    const approved = await getApprovedTraVideoFrames(video);
    if (approved.sourceVideoContentHash !== attachedSource.sourceSha256) {
      throw new Error('The approved TRA video frame set does not match the saved source.');
    }
    return exactSavedSubset(
      approved.frames,
      attachedSource.frames,
      video,
      attachedSource.sourceSha256
    );
  }

  const savedSelection = parseGeneratedVideoFrameSelection(selection);
  if (!savedSelection) {
    throw new Error('Selected TRA video frames require valid saved selection provenance.');
  }
  if (
    savedSelection.sourceVideoMediaId !== attachedSource.mediaId ||
    savedSelection.sourceVideoContentHash !== attachedSource.sourceSha256 ||
    savedSelection.frames.length !== attachedSource.frames.length ||
    savedSelection.frames.some((frame, index) =>
      frame.timestampMs !== attachedSource.frames[index].timestampMs ||
      frame.approvedPngSha256 !== attachedSource.frames[index].approvedPngSha256
    )
  ) {
    throw new Error('The saved TRA video selection does not match this creative provenance.');
  }

  const context = await loadVideoSelectionContext(video);
  const library = context?.library;
  if (!library || library.id !== savedSelection.libraryId) {
    throw new Error(
      'The saved TRA video frame library is missing or invalid. Reanalyze the video before revising this creative.'
    );
  }
  const approved = await extractVideoSelectionFrames(
    video,
    context!,
    savedSelection.frames.map((frame) => frame.libraryFrameId)
  );
  if (
    approved.sourceVideoContentHash !== attachedSource.sourceSha256 ||
    approved.selectionProvenance.length !== savedSelection.frames.length ||
    approved.selectionProvenance.some((frame, index) => {
      const expected = savedSelection.frames[index];
      return (
        frame.frameIndex !== expected.frameIndex ||
        frame.libraryFrameId !== expected.libraryFrameId ||
        frame.candidateFrameSha256 !== expected.candidateFrameSha256 ||
        frame.timestampMs !== expected.timestampMs ||
        frame.approvedPngSha256 !== expected.approvedPngSha256
      );
    })
  ) {
    throw new Error(
      'The selected TRA video frames no longer match saved provenance. Reanalyze the video before revising this creative.'
    );
  }
  return exactSavedSubset(
    approved.frames,
    attachedSource.frames,
    video,
    attachedSource.sourceSha256
  );
}
