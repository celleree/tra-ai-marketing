import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import type { VideoCandidateFrameBinding } from '@/lib/video/generation-selection-contract';
import { validateVideoIntelligencePreparationManifest, type VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import { videoSourceHash } from '@/lib/video/library-service';
import { assertDurableVideoIntelligenceAvailable } from '@/lib/video/preview-availability';
import { extractPng, selectedCandidateBindings, selectedRepresentatives,
  type ApprovedSelectedTraVideoFrameSet, type SelectedTraVideoFrameProvenance } from '@/lib/video/selected-frames';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

export interface PreparedSelectedTraVideoFrameDependencies { temporaryRoot?: string }
const reanalyze = (reason: string): never => {
  throw new Error(`Prepared selected TRA video frames require reanalysis: ${reason}`);
};

const assertPreparedBoundary = (source: HydratedTraVideoSource, library: VideoFrameLibrary,
  manifest: VideoIntelligencePreparationManifest, selections: ReturnType<typeof selectedRepresentatives>,
  representativeOnly: boolean) => {
  validateVideoIntelligencePreparationManifest(manifest);
  if (source.role !== 'TRA_VIDEO' || source.media.mediaType !== 'VIDEO' || source.media.mimeType !== 'video/mp4'
    || source.stored.mediaType !== 'VIDEO' || source.stored.mimeType !== 'video/mp4') {
    reanalyze('the hydrated source is not a TRA_VIDEO MP4.');
  }
  if (manifest.sourceVideoMediaId !== source.media.id || manifest.sourceVideoFileName !== source.media.fileName
    || manifest.sourceVideoFileName !== source.stored.fileName || manifest.sourceVideoContentHash !== videoSourceHash(source)
    || manifest.sourceVideoByteLength !== source.stored.buffer.length || source.media.size !== source.stored.buffer.length) {
    reanalyze('the preparation manifest does not match the hydrated source.');
  }
  if (manifest.durationMs !== library.durationMs) reanalyze('the preparation duration does not match the saved library.');
  if ((library.analysisModels.transcription !== null && library.analysisModels.transcription !== manifest.analyzerFingerprint.transcriptionModel)
    || !isDeepStrictEqual(library.analysisModels.vision, [manifest.analyzerFingerprint.visionModel])) {
    reanalyze('the preparation analyzer does not match the saved library.');
  }
  return selections.map((selection) => {
    const prepared = manifest.candidates[selection.candidate.candidateIndex];
    if (!prepared || (representativeOnly && !manifest.representativeBundle.entries.some(({ candidateIndex }) => candidateIndex === prepared.candidateIndex))
      || !manifest.groups.some((group) => group.representativeIndex === selection.representative.candidateIndex
        && group.candidateIndexes.includes(selection.candidate.candidateIndex))
      || prepared.candidateIndex !== selection.candidate.candidateIndex || prepared.timestampMs !== selection.candidate.timestampMs
      || prepared.frameSha256 !== selection.candidate.frameSha256
      || !isDeepStrictEqual(prepared.extractionReasons, selection.candidate.extractionReasons)) {
      reanalyze(`selected frame ${selection.frameId} does not match the preparation manifest.`);
    }
    return { ...selection, prepared };
  });
};

/** Accept only the validated `.manifest` returned by `loadVideoIntelligencePreparation`.
 * The loader owns artifact/JPEG integrity; this boundary extracts fresh PNGs from the hydrated source. */
export const getApprovedPreparedSelectedTraVideoFrames = async (source: HydratedTraVideoSource,
  library: VideoFrameLibrary, frameIds: readonly string[] | readonly VideoCandidateFrameBinding[], manifest: VideoIntelligencePreparationManifest,
  dependencies: PreparedSelectedTraVideoFrameDependencies = {}): Promise<ApprovedSelectedTraVideoFrameSet> => {
  assertDurableVideoIntelligenceAvailable();
  const candidateAddressed = frameIds.length > 0 && typeof frameIds[0] !== 'string';
  const selections = assertPreparedBoundary(source, library, manifest, candidateAddressed
    ? selectedCandidateBindings(source, library, frameIds as readonly VideoCandidateFrameBinding[])
    : selectedRepresentatives(source, library, frameIds as readonly string[]), !candidateAddressed);
  const buildResult = (buffers: Buffer[]): ApprovedSelectedTraVideoFrameSet => {
    const frames: ApprovedTraVideoFrame[] = [];
    const selectionProvenance: SelectedTraVideoFrameProvenance[] = [];
    for (const [frameIndex, selection] of selections.entries()) {
      const buffer = buffers[frameIndex];
      const approvedPngSha256 = createHash('sha256').update(buffer).digest('hex');
      frames.push({ frameIndex, timestampMs: selection.prepared.timestampMs, mimeType: 'image/png', buffer,
        frameSha256: approvedPngSha256, byteLength: buffer.length, sourceRole: 'TRA_VIDEO',
        sourceVideoMediaId: source.media.id, sourceVideoFileName: source.media.fileName,
        sourceVideoContentHash: manifest.sourceVideoContentHash, approvedHumanSource: true, cacheKey: null });
      selectionProvenance.push({ frameIndex, libraryFrameId: selection.frameId,
        candidateFrameSha256: selection.prepared.frameSha256, timestampMs: selection.prepared.timestampMs,
        approvedPngSha256,
        ...(candidateAddressed ? { candidateIndex: selection.prepared.candidateIndex,
          representativeFrameId: selection.representative.id } : {}) });
    }
    return { source, sourceVideoContentHash: manifest.sourceVideoContentHash, durationMs: manifest.durationMs,
      frames, reused: false, selectionProvenance };
  };
  if (candidateAddressed) {
    return withTemporaryTraVideoFrameCandidates(source, async (set) => {
      if (set.sourceVideoContentHash !== manifest.sourceVideoContentHash || set.durationMs !== manifest.durationMs) {
        reanalyze('the regenerated candidate set has drifted from the frozen preparation.');
      }
      const buffers: Buffer[] = [];
      for (const selection of selections) {
        const regenerated = set.candidates[selection.prepared.candidateIndex];
        if (!regenerated || regenerated.timestampMs !== selection.prepared.timestampMs
          || regenerated.frameSha256 !== selection.prepared.frameSha256
          || createHash('sha256').update(await readFile(regenerated.temporaryPath)).digest('hex') !== selection.prepared.frameSha256) {
          reanalyze(`candidate frame ${selection.frameId} has drifted from the frozen preparation.`);
        }
        buffers.push(await extractPng(set.temporarySourceVideoPath, regenerated,
          manifest.effectiveIntervalFps, manifest.analyzerFingerprint.candidatePolicy.maxWidth));
      }
      return buildResult(buffers);
    }, {}, manifest.analyzerFingerprint.candidatePolicy);
  }
  const directory = await mkdtemp(path.join(dependencies.temporaryRoot ?? tmpdir(), 'tra-prepared-selected-'));
  const sourcePath = path.join(directory, 'source.mp4');
  try {
    await writeFile(sourcePath, source.stored.buffer);
    const settled = await Promise.allSettled(selections.map(({ prepared }) => extractPng(sourcePath, prepared,
      manifest.effectiveIntervalFps, manifest.analyzerFingerprint.candidatePolicy.maxWidth)));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    const buffers = settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    return buildResult(buffers);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
