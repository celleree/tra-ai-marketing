import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { validateVideoIntelligencePreparationManifest, type VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import { assertLocalVideoIntelligence, videoSourceHash } from '@/lib/video/library-service';
import { extractPng, selectedRepresentatives, type ApprovedSelectedTraVideoFrameSet, type SelectedTraVideoFrameProvenance } from '@/lib/video/selected-frames';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

export interface PreparedSelectedTraVideoFrameDependencies { temporaryRoot?: string }
const reanalyze = (reason: string): never => {
  throw new Error(`Prepared selected TRA video frames require reanalysis: ${reason}`);
};

const assertPreparedBoundary = (source: HydratedTraVideoSource, library: VideoFrameLibrary,
  manifest: VideoIntelligencePreparationManifest, selections: ReturnType<typeof selectedRepresentatives>) => {
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
  if (library.analysisModels.transcription !== manifest.analyzerFingerprint.transcriptionModel
    || !isDeepStrictEqual(library.analysisModels.vision, [manifest.analyzerFingerprint.visionModel])) {
    reanalyze('the preparation analyzer does not match the saved library.');
  }
  return selections.map((selection) => {
    const prepared = manifest.candidates[selection.candidate.candidateIndex];
    if (!prepared || !manifest.representativeBundle.entries.some(({ candidateIndex }) => candidateIndex === prepared.candidateIndex)
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
  library: VideoFrameLibrary, frameIds: readonly string[], manifest: VideoIntelligencePreparationManifest,
  dependencies: PreparedSelectedTraVideoFrameDependencies = {}): Promise<ApprovedSelectedTraVideoFrameSet> => {
  assertLocalVideoIntelligence();
  const selections = assertPreparedBoundary(source, library, manifest, selectedRepresentatives(source, library, frameIds));
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
        approvedPngSha256 });
    }
    return { source, sourceVideoContentHash: manifest.sourceVideoContentHash, durationMs: manifest.durationMs,
      frames, reused: false, selectionProvenance };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
