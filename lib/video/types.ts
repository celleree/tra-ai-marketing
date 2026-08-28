import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';

export const MAX_REPRESENTATIVE_VIDEO_FRAMES = 6;
export const MAX_PROVIDER_VIDEO_FRAMES = 3;

export interface ApprovedTraVideoFrame {
  frameIndex: number;
  timestampMs: number;
  mimeType: 'image/png';
  buffer: Buffer;
  sourceRole: 'TRA_VIDEO';
  sourceVideoMediaId: string;
  sourceVideoFileName: string;
  sourceVideoContentHash: string;
  approvedHumanSource: true;
  cacheKey: string;
}

export interface ApprovedTraVideoFrameSet {
  source: HydratedCreativeSourceAsset & { role: 'TRA_VIDEO' };
  sourceVideoContentHash: string;
  durationMs: number;
  frames: ApprovedTraVideoFrame[];
  reused: boolean;
}

export interface VideoFrameManifestFrame {
  frameIndex: number;
  timestampMs: number;
  mimeType: 'image/png';
  cacheKey: string;
}

export interface VideoFrameManifest {
  version: 1;
  sourceRole: 'TRA_VIDEO';
  sourceVideoMediaId: string;
  sourceVideoFileName: string;
  sourceVideoMimeType: 'video/mp4';
  sourceVideoContentHash: string;
  durationMs: number;
  frames: VideoFrameManifestFrame[];
}
