export interface GenerateVideoFrameSelection {
  libraryId: string;
  sourceVideoContentHash: string;
  frameIds: string[];
}

export interface GeneratedVideoFrameProvenance {
  frameIndex: number;
  libraryFrameId: string;
  candidateFrameSha256: string;
  timestampMs: number;
  approvedPngSha256: string;
}

export interface GeneratedVideoFrameSelection {
  libraryId: string;
  sourceVideoMediaId: string;
  sourceVideoContentHash: string;
  frames: GeneratedVideoFrameProvenance[];
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

export const parseGenerateVideoFrameSelection = (
  value: unknown
): GenerateVideoFrameSelection | null => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'libraryId',
      'sourceVideoContentHash',
      'frameIds',
    ])
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
  return { libraryId, sourceVideoContentHash, frameIds };
};

const parseFrameProvenance = (
  value: unknown
): GeneratedVideoFrameProvenance | null => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'frameIndex',
      'libraryFrameId',
      'candidateFrameSha256',
      'timestampMs',
      'approvedPngSha256',
    ])
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
  return {
    frameIndex,
    libraryFrameId,
    candidateFrameSha256,
    timestampMs,
    approvedPngSha256,
  };
};

export const parseGeneratedVideoFrameSelection = (
  value: unknown
): GeneratedVideoFrameSelection | null => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'libraryId',
      'sourceVideoMediaId',
      'sourceVideoContentHash',
      'frames',
    ])
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

  const frames = value.frames.map(parseFrameProvenance);
  if (frames.some((frame) => !frame)) return null;
  const validFrames = frames as GeneratedVideoFrameProvenance[];
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
  };
};
