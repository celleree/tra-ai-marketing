import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { getJpegDimensions, inspectTemporaryCandidateFile } from '@/lib/video/candidate-file-integrity';
import type { TemporaryVideoFrameCandidate, VideoFrameAnalysisCandidate } from '@/lib/video/candidate-types';

export interface VideoFrameThumbnail {
  sourceVideoMediaId: string;
  sourceVideoContentHash: string;
  candidateIndex: number;
  timestampMs: number;
  frameSha256: string;
  thumbnailDataUrl: string;
}

export const createVideoFrameThumbnailFromBytes = async (
  candidate: VideoFrameAnalysisCandidate,
  bytes: Buffer
): Promise<VideoFrameThumbnail> => {
  const dimensions = getJpegDimensions(bytes);
  if (
    candidate.providerEligible !== false || candidate.sourceRole !== 'TRA_VIDEO' || candidate.mimeType !== 'image/jpeg'
    || !dimensions || dimensions.width !== candidate.width || dimensions.height !== candidate.height
    || bytes.length !== candidate.byteLength || createHash('sha256').update(bytes).digest('hex') !== candidate.frameSha256
  ) {
    throw new Error('Frame thumbnails require an analysis-only TRA candidate.');
  }
  const thumbnail = await sharp(bytes, { limitInputPixels: 40_000_000 }).resize({ width: 280, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return {
    sourceVideoMediaId: candidate.sourceVideoMediaId,
    sourceVideoContentHash: candidate.sourceVideoContentHash,
    candidateIndex: candidate.candidateIndex,
    timestampMs: candidate.timestampMs,
    frameSha256: candidate.frameSha256,
    thumbnailDataUrl: `data:image/jpeg;base64,${thumbnail.toString('base64')}`,
  };
};

export const createVideoFrameThumbnail = async (
  candidate: TemporaryVideoFrameCandidate
): Promise<VideoFrameThumbnail> => {
  if (candidate.lifecycle !== 'TEMPORARY' || candidate.providerEligible || candidate.sourceRole !== 'TRA_VIDEO') {
    throw new Error('Frame thumbnails require an analysis-only TRA candidate.');
  }
  const integrity = await inspectTemporaryCandidateFile(candidate.temporaryPath);
  if (
    !integrity || integrity.width !== candidate.width || integrity.height !== candidate.height
    || integrity.byteLength !== candidate.byteLength || integrity.frameSha256 !== candidate.frameSha256
  ) {
    throw new Error('Frame thumbnail candidate integrity mismatch.');
  }
  return createVideoFrameThumbnailFromBytes(candidate, await readFile(candidate.temporaryPath));
};
