import { createHash } from 'node:crypto';
import { parseSourceOverlayDecision, type SourceOverlayDecision } from '@/lib/video/source-overlay-contract';

export interface VideoCandidateFrameBinding {
  frameId: string;
  representativeFrameId: string;
  candidateIndex: number;
  timestampMs: number;
  frameSha256: string;
}

export interface GenerateVideoFrameSelection {
  libraryId: string;
  sourceVideoContentHash: string;
  frameIds: string[];
  version?: 2 | 3;
  sourceOverlays?: SourceOverlayDecision[];
  sourceVideoMediaId?: string;
  librarySha256?: string;
  candidateBindings?: VideoCandidateFrameBinding[];
}

export interface GeneratedVideoFrameProvenance {
  frameIndex: number;
  libraryFrameId: string;
  candidateFrameSha256: string;
  timestampMs: number;
  approvedPngSha256: string;
  representativeFrameId?: string;
  candidateIndex?: number;
}

export interface GeneratedVideoFrameSelection {
  libraryId: string;
  sourceVideoMediaId: string;
  sourceVideoContentHash: string;
  frames: GeneratedVideoFrameProvenance[];
  librarySha256?: string;
}

const LIBRARY_ID = /^video-library:[a-f0-9]{64}$/;
const FRAME_ID = /^video-frame:[a-f0-9]{64}$/;
const MEDIA_ID = /^media_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => key in value);

export const videoCandidateFrameId = (sourceHash: string, timestampMs: number, frameHash: string) =>
  `video-frame:${createHash('sha256').update(`${sourceHash}:${timestampMs}:${frameHash}`).digest('hex')}`;

const parseCandidateBinding = (value: unknown, sourceHash: string): VideoCandidateFrameBinding | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['frameId', 'representativeFrameId', 'candidateIndex', 'timestampMs', 'frameSha256'])
    || typeof value.frameId !== 'string' || !FRAME_ID.test(value.frameId)
    || typeof value.representativeFrameId !== 'string' || !FRAME_ID.test(value.representativeFrameId)
    || !Number.isSafeInteger(value.candidateIndex) || Number(value.candidateIndex) < 0
    || !Number.isSafeInteger(value.timestampMs) || Number(value.timestampMs) < 0
    || typeof value.frameSha256 !== 'string' || !SHA256.test(value.frameSha256)
    || value.frameId !== videoCandidateFrameId(sourceHash, Number(value.timestampMs), value.frameSha256)) return null;
  return value as unknown as VideoCandidateFrameBinding;
};

export const parseGenerateVideoFrameSelection = (
  value: unknown
): GenerateVideoFrameSelection | null => {
  if (
    !isRecord(value) ||
    !(hasExactKeys(value, [
      'libraryId',
      'sourceVideoContentHash',
      'frameIds',
    ]) || hasExactKeys(value, ['version', 'libraryId', 'sourceVideoContentHash', 'frameIds', 'sourceOverlays'])
      || hasExactKeys(value, ['version', 'libraryId', 'sourceVideoMediaId', 'sourceVideoContentHash',
        'librarySha256', 'frameIds', 'candidateBindings', 'sourceOverlays']))
  ) {
    return null;
  }

  const { libraryId, sourceVideoContentHash, frameIds } = value;
  if (
    typeof libraryId !== 'string' ||
    !LIBRARY_ID.test(libraryId) ||
    typeof sourceVideoContentHash !== 'string' ||
    !SHA256.test(sourceVideoContentHash) ||
    !Array.isArray(frameIds) ||
    frameIds.length < 1 ||
    frameIds.length > 3 ||
    !frameIds.every(
      (frameId) => typeof frameId === 'string' && FRAME_ID.test(frameId)
    ) ||
    new Set(frameIds).size !== frameIds.length
  ) {
    return null;
  }
  if ('version' in value) {
    if (!Array.isArray(value.sourceOverlays) || value.sourceOverlays.length !== frameIds.length) return null;
    const sourceOverlays = value.sourceOverlays.map(parseSourceOverlayDecision);
    if (sourceOverlays.some((decision) => !decision || decision.status === 'UNSAFE')) return null;
    if (value.version === 2 && !('candidateBindings' in value)) {
      return { version: 2, libraryId, sourceVideoContentHash, frameIds, sourceOverlays: sourceOverlays as SourceOverlayDecision[] };
    }
    if (value.version !== 3 || typeof value.sourceVideoMediaId !== 'string' || !MEDIA_ID.test(value.sourceVideoMediaId)
      || typeof value.librarySha256 !== 'string' || !SHA256.test(value.librarySha256)
      || !Array.isArray(value.candidateBindings) || value.candidateBindings.length !== frameIds.length) return null;
    const candidateBindings = value.candidateBindings.map((binding) => parseCandidateBinding(binding, sourceVideoContentHash));
    if (candidateBindings.some((binding, index) => !binding || binding.frameId !== frameIds[index])) return null;
    return { version: 3, libraryId, sourceVideoMediaId: value.sourceVideoMediaId, sourceVideoContentHash,
      librarySha256: value.librarySha256, frameIds, candidateBindings: candidateBindings as VideoCandidateFrameBinding[],
      sourceOverlays: sourceOverlays as SourceOverlayDecision[] };
  }
  return { libraryId, sourceVideoContentHash, frameIds };
};

const parseFrameProvenance = (
  value: unknown
): GeneratedVideoFrameProvenance | null => {
  if (
    !isRecord(value) ||
    !(hasExactKeys(value, [
      'frameIndex',
      'libraryFrameId',
      'candidateFrameSha256',
      'timestampMs',
      'approvedPngSha256',
    ]) || hasExactKeys(value, ['frameIndex', 'libraryFrameId', 'candidateFrameSha256', 'timestampMs',
      'approvedPngSha256', 'representativeFrameId', 'candidateIndex']))
  ) {
    return null;
  }

  const {
    frameIndex,
    libraryFrameId,
    candidateFrameSha256,
    timestampMs,
    approvedPngSha256,
  } = value;
  if (
    typeof frameIndex !== 'number' ||
    !Number.isSafeInteger(frameIndex) ||
    frameIndex < 0 ||
    typeof libraryFrameId !== 'string' ||
    !FRAME_ID.test(libraryFrameId) ||
    typeof candidateFrameSha256 !== 'string' ||
    !SHA256.test(candidateFrameSha256) ||
    typeof timestampMs !== 'number' ||
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    typeof approvedPngSha256 !== 'string' ||
    !SHA256.test(approvedPngSha256)
  ) {
    return null;
  }
  if ('candidateIndex' in value && (!Number.isSafeInteger(value.candidateIndex) || Number(value.candidateIndex) < 0
    || typeof value.representativeFrameId !== 'string' || !FRAME_ID.test(value.representativeFrameId))) return null;
  return {
    frameIndex,
    libraryFrameId,
    candidateFrameSha256,
    timestampMs,
    approvedPngSha256,
    ...('candidateIndex' in value ? { candidateIndex: value.candidateIndex as number,
      representativeFrameId: value.representativeFrameId as string } : {}),
  };
};

export const parseGeneratedVideoFrameSelection = (
  value: unknown
): GeneratedVideoFrameSelection | null => {
  if (
    !isRecord(value) ||
    !(hasExactKeys(value, [
      'libraryId',
      'sourceVideoMediaId',
      'sourceVideoContentHash',
      'frames',
    ]) || hasExactKeys(value, ['libraryId', 'sourceVideoMediaId', 'sourceVideoContentHash', 'frames', 'librarySha256']))
  ) {
    return null;
  }

  const { libraryId, sourceVideoMediaId, sourceVideoContentHash } = value;
  if (
    typeof libraryId !== 'string' ||
    !LIBRARY_ID.test(libraryId) ||
    typeof sourceVideoMediaId !== 'string' ||
    !MEDIA_ID.test(sourceVideoMediaId) ||
    typeof sourceVideoContentHash !== 'string' ||
    !SHA256.test(sourceVideoContentHash) ||
    !Array.isArray(value.frames) ||
    value.frames.length < 1 ||
    value.frames.length > 3
  ) {
    return null;
  }
  if ('librarySha256' in value && (typeof value.librarySha256 !== 'string' || !SHA256.test(value.librarySha256))) return null;

  const frames = value.frames.map(parseFrameProvenance);
  if (frames.some((frame) => !frame)) return null;
  const validFrames = frames as GeneratedVideoFrameProvenance[];
  if (validFrames.some((frame) => Boolean(frame.candidateIndex !== undefined) !== Boolean(value.librarySha256))) return null;
  if (value.librarySha256 && validFrames.some((frame) =>
    frame.libraryFrameId !== videoCandidateFrameId(sourceVideoContentHash, frame.timestampMs, frame.candidateFrameSha256))) return null;
  if (
    new Set(validFrames.map((frame) => frame.frameIndex)).size !==
      validFrames.length ||
    new Set(validFrames.map((frame) => frame.libraryFrameId)).size !==
      validFrames.length
  ) {
    return null;
  }
  return {
    libraryId,
    sourceVideoMediaId,
    sourceVideoContentHash,
    frames: validFrames,
    ...(value.librarySha256 ? { librarySha256: value.librarySha256 as string } : {}),
  };
};
