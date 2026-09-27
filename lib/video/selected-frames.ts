import { createHash } from 'node:crypto';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { runFfmpeg } from '@/lib/video/ffmpeg';
import { isStructurallyValidPng } from '@/lib/video/frame-cache';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { videoCandidateFrameId, type VideoCandidateFrameBinding } from '@/lib/video/generation-selection-contract';
import {
  assertLocalVideoIntelligence,
  videoSourceHash,
} from '@/lib/video/library-service';
import {
  MAX_PROVIDER_VIDEO_FRAMES,
  type ApprovedTraVideoFrame,
  type ApprovedTraVideoFrameSet,
} from '@/lib/video/types';

export interface SelectedTraVideoFrameProvenance {
  frameIndex: number; libraryFrameId: string; candidateFrameSha256: string;
  timestampMs: number; approvedPngSha256: string;
  representativeFrameId?: string; candidateIndex?: number;
}

export interface ApprovedSelectedTraVideoFrameSet extends ApprovedTraVideoFrameSet {
  selectionProvenance: SelectedTraVideoFrameProvenance[];
}

const reanalyze = (reason: string): never => {
  throw new Error(`Selected TRA video frames require reanalysis: ${reason}`);
};

export const selectedRepresentatives = (
  source: HydratedTraVideoSource,
  library: VideoFrameLibrary,
  frameIds: readonly string[]
) => {
  if (
    library.sourceVideoMediaId !== source.media.id ||
    library.sourceVideoContentHash !== videoSourceHash(source)
  ) {
    throw new Error('Selected TRA video frame library does not match the hydrated source.');
  }
  if (!Number.isFinite(library.durationMs) || library.durationMs <= 0) {
    reanalyze('the saved video duration is invalid.');
  }
  if (frameIds.length < 1 || frameIds.length > MAX_PROVIDER_VIDEO_FRAMES) {
    throw new Error(`Select between 1 and ${MAX_PROVIDER_VIDEO_FRAMES} TRA video frames.`);
  }
  if (new Set(frameIds).size !== frameIds.length) {
    throw new Error('Selected TRA video frame IDs must be unique.');
  }

  return frameIds.map((frameId) => {
    const representative = library.representativeFrames.find((frame) => frame.id === frameId);
    if (!representative) {
      throw new Error(`Unknown TRA video representative frame ID: ${frameId}.`);
    }
    if (
      !Number.isSafeInteger(representative.timestampMs) ||
      representative.timestampMs < 0 ||
      representative.timestampMs >= library.durationMs ||
      !/^[a-f0-9]{64}$/.test(representative.frameSha256)
    ) {
      reanalyze(`representative frame ${frameId} has invalid timestamp or integrity metadata.`);
    }
    const candidate = library.candidates.find(
      (entry) => entry.candidateIndex === representative.candidateIndex);
    if (!candidate) {
      throw new Error(
        `Selected TRA video frames require reanalysis: representative frame ${frameId} no longer matches its saved candidate.`
      );
    }
    if (
      candidate.timestampMs !== representative.timestampMs ||
      candidate.frameSha256 !== representative.frameSha256 ||
      !Array.isArray(candidate.extractionReasons) ||
      !candidate.extractionReasons.some(
        (reason) => reason === 'INTERVAL' || reason === 'SCENE_CHANGE'
      )
    ) {
      reanalyze(`representative frame ${frameId} no longer matches its saved candidate.`);
    }
    return { frameId, representative, candidate };
  });
};

/** A candidate is eligible only through its original, frozen technical group. */
export const selectedCandidateBindings = (
  source: HydratedTraVideoSource, library: VideoFrameLibrary, bindings: readonly VideoCandidateFrameBinding[],
) => {
  if (library.sourceVideoMediaId !== source.media.id || library.sourceVideoContentHash !== videoSourceHash(source)) {
    throw new Error('Selected TRA video frame library does not match the hydrated source.');
  }
  if (!Number.isFinite(library.durationMs) || library.durationMs <= 0
    || bindings.length < 1 || bindings.length > MAX_PROVIDER_VIDEO_FRAMES
    || new Set(bindings.map((binding) => binding.frameId)).size !== bindings.length) {
    throw new Error('Selected TRA video candidate bindings are invalid.');
  }
  return bindings.map((binding) => {
    const representative = library.representativeFrames.find((frame) => frame.id === binding.representativeFrameId);
    const candidate = library.candidates.find((entry) => entry.candidateIndex === binding.candidateIndex);
    if (!representative || !candidate || !representative.candidateIndexes.includes(binding.candidateIndex)
      || candidate.timestampMs !== binding.timestampMs || candidate.frameSha256 !== binding.frameSha256
      || candidate.timestampMs < 0 || candidate.timestampMs >= library.durationMs
      || binding.frameId !== videoCandidateFrameId(library.sourceVideoContentHash, candidate.timestampMs, candidate.frameSha256)) {
      return reanalyze(`candidate frame ${binding.frameId} does not match its saved technical group.`);
    }
    return { frameId: binding.frameId, representative, candidate };
  });
};

export const extractPng = async (
  sourcePath: string,
  candidate: Pick<
    VideoFrameLibrary['candidates'][number],
    'timestampMs' | 'extractionReasons'
  >,
  effectiveIntervalFps: number,
  maxWidth: number
) => {
  const intervalFilter = candidate.extractionReasons.includes('INTERVAL')
    ? `fps=${effectiveIntervalFps}:eof_action=pass,`
    : '';
  const selection =
    `${intervalFilter}select='gte(t,${(candidate.timestampMs - 0.5) / 1000})'`;
  const result = await runFfmpeg([
    '-hide_banner', '-nostdin', '-v', 'error', '-i', sourcePath,
    '-map', '0:v:0', '-vf',
    `${selection},scale=w='min(iw,${maxWidth})':h=-2`,
    '-frames:v', '1', '-fps_mode', 'passthrough', '-an',
    '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ]).catch(() =>
    reanalyze(`fresh PNG extraction failed at ${candidate.timestampMs}ms.`)
  );
  const buffer = result.stdout;
  if (!isStructurallyValidPng(buffer)) {
    reanalyze(`fresh PNG extraction was invalid at ${candidate.timestampMs}ms.`);
  }
  return buffer;
};

export const getApprovedSelectedTraVideoFrames = async (
  source: HydratedTraVideoSource,
  library: VideoFrameLibrary,
  frameIds: readonly string[] | readonly VideoCandidateFrameBinding[]
): Promise<ApprovedSelectedTraVideoFrameSet> => {
  assertLocalVideoIntelligence();
  const candidateAddressed = frameIds.length > 0 && typeof frameIds[0] !== 'string';
  const selections = candidateAddressed
    ? selectedCandidateBindings(source, library, frameIds as readonly VideoCandidateFrameBinding[])
    : selectedRepresentatives(source, library, frameIds as readonly string[]);

  return withTemporaryTraVideoFrameCandidates(source, async (set) => {
    if (
      set.sourceVideoMediaId !== library.sourceVideoMediaId ||
      set.sourceVideoContentHash !== library.sourceVideoContentHash ||
      set.durationMs !== library.durationMs
    ) {
      reanalyze('the regenerated candidate set has drifted from the saved library.');
    }

    const frames: ApprovedTraVideoFrame[] = [];
    const selectionProvenance: SelectedTraVideoFrameProvenance[] = [];
    for (const [frameIndex, selection] of selections.entries()) {
      const regenerated = set.candidates[selection.candidate.candidateIndex];
      if (
        !regenerated ||
        regenerated.timestampMs !== selection.candidate.timestampMs ||
        regenerated.frameSha256 !== selection.candidate.frameSha256
      ) {
        reanalyze(`representative frame ${selection.frameId} has drifted from fresh analysis.`);
      }
      const buffer = await extractPng(
        set.temporarySourceVideoPath,
        regenerated,
        set.effectiveIntervalFps,
        set.policy.maxWidth
      );
      const approvedPngSha256 = createHash('sha256').update(buffer).digest('hex');
      frames.push({
        frameIndex,
        timestampMs: regenerated.timestampMs,
        mimeType: 'image/png',
        buffer,
        frameSha256: approvedPngSha256,
        byteLength: buffer.length,
        sourceRole: 'TRA_VIDEO',
        sourceVideoMediaId: source.media.id,
        sourceVideoFileName: source.media.fileName,
        sourceVideoContentHash: set.sourceVideoContentHash,
        approvedHumanSource: true,
        cacheKey: null,
      });
      selectionProvenance.push({
        frameIndex,
        libraryFrameId: selection.frameId,
        candidateFrameSha256: regenerated.frameSha256,
        timestampMs: regenerated.timestampMs,
        approvedPngSha256,
        ...(candidateAddressed ? { representativeFrameId: selection.representative.id,
          candidateIndex: regenerated.candidateIndex } : {}),
      });
    }

    return {
      source,
      sourceVideoContentHash: set.sourceVideoContentHash,
      durationMs: set.durationMs,
      frames,
      reused: false,
      selectionProvenance,
    };
  });
};
