import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { detectImageMimeType } from '@/lib/media/storage';

export interface TemporaryCandidateFileIntegrity {
  width: number;
  height: number;
  byteLength: number;
  frameSha256: string;
}

export interface TemporarySourceVideoFileIntegrity {
  byteLength: number;
  contentSha256: string;
}

const readRegularFile = async (temporaryPath: string) => {
  try {
    const stats = await lstat(temporaryPath);
    if (!stats.isFile()) return null;
    return await readFile(temporaryPath);
  } catch {
    return null;
  }
};

const getJpegDimensions = (buffer: Buffer) => {
  if (
    detectImageMimeType(buffer) !== 'image/jpeg' ||
    buffer.length < 4 ||
    buffer[buffer.length - 2] !== 0xff ||
    buffer[buffer.length - 1] !== 0xd9
  ) {
    return null;
  }

  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (marker === 0xda) {
      const componentCount = buffer[offset + 2];
      if (!dimensions || segmentLength !== 6 + componentCount * 2) return null;
      offset += segmentLength;
      let entropyByteCount = 0;
      while (offset < buffer.length - 2) {
        if (buffer[offset] !== 0xff) {
          entropyByteCount += 1;
          offset += 1;
          continue;
        }
        const next = buffer[offset + 1];
        if (next === 0x00) {
          entropyByteCount += 1;
          offset += 2;
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
          offset += 2;
          continue;
        }
        return null;
      }
      return entropyByteCount > 0 ? dimensions : null;
    }
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (segmentLength < 7) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) return null;
      dimensions = { width, height };
    }
    offset += segmentLength;
  }
  return null;
};

export const inspectTemporarySourceVideoFile = async (
  temporaryPath: string
): Promise<TemporarySourceVideoFileIntegrity | null> => {
  const buffer = await readRegularFile(temporaryPath);
  if (!buffer) return null;
  return {
    byteLength: buffer.length,
    contentSha256: createHash('sha256').update(buffer).digest('hex'),
  };
};

export const inspectTemporaryCandidateFile = async (
  temporaryPath: string
): Promise<TemporaryCandidateFileIntegrity | null> => {
  const buffer = await readRegularFile(temporaryPath);
  if (!buffer) return null;
  const dimensions = getJpegDimensions(buffer);
  if (!dimensions) return null;
  return {
    ...dimensions,
    byteLength: buffer.length,
    frameSha256: createHash('sha256').update(buffer).digest('hex'),
  };
};
