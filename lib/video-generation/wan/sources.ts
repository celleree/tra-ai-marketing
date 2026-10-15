import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getMediaStorage } from '@/lib/media/local-storage';
import { isSafeMediaId, validateStoredMedia } from '@/lib/media/storage';
import { parseFfmpegDurationMs, runFfmpeg } from '@/lib/video/ffmpeg';
import { MAX_DURATION_MS, MAX_FRAMES, MAX_SOURCE_BYTES, WanError } from './types';

export const loadWanSources = async (imageId: string, videoId: string) => {
  if (!isSafeMediaId(imageId) || !isSafeMediaId(videoId)) throw new WanError('Choose a stored character image and MP4.');
  const storage = getMediaStorage();
  const [image, video] = await Promise.all([storage.readMediaById(imageId), storage.readMediaById(videoId)]);
  if (!image || image.mediaType !== 'IMAGE' || !video || video.mediaType !== 'VIDEO') throw new WanError('Source files are unavailable. Upload them again.');
  validateStoredMedia(image); validateStoredMedia(video);
  if (image.buffer.length > 10 * 1024 * 1024) throw new WanError('Character image must be at most 10 MB.');
  if (video.buffer.length > MAX_SOURCE_BYTES) throw new WanError('Source MP4 must be at most 100 MB.');
  return { image, video };
};
/** Decode every source frame; never infer billable frames from browser FPS/duration metadata. */
export const probeWanVideo = async (bytes: Buffer) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wan-probe-'));
  try {
    const input = path.join(dir, 'source.mp4');
    await writeFile(input, bytes);
    const result = await runFfmpeg(['-hide_banner', '-nostdin', '-v', 'info', '-xerror', '-i', input,
      '-map', '0:v:0', '-an', '-frames:v', String(MAX_FRAMES + 1), '-fps_mode', 'passthrough',
      '-progress', 'pipe:1', '-nostats', '-f', 'null', '-']);
    const frames = [...result.stdout.toString().matchAll(/^frame=(\d+)\s*$/gm)].map(match => Number(match[1])).pop();
    const metadataDuration = parseFfmpegDurationMs(result.stderr);
    const decodedUs = [...result.stdout.toString().matchAll(/^out_time_us=(\d+)\s*$/gm)].map(match => Number(match[1])).pop();
    const durationMs = metadataDuration && decodedUs ? Math.max(metadataDuration, Math.ceil(decodedUs / 1000)) : null;
    if (!frames || frames > MAX_FRAMES || !durationMs || durationMs > MAX_DURATION_MS) throw new WanError('Source must be at most 30 seconds and 1800 decoded frames.');
    return { frames, durationMs };
  } finally { await rm(dir, { recursive: true, force: true }); }
};
/** Only server-validated R2 object names; URLs never leave the paid server boundary. */
export const signWanSource = async (fileName: string) => {
  if (!/^media_[a-f0-9]{32}\.(png|jpg|webp|mp4)$/.test(fileName)) throw new WanError('Invalid stored source.');
  const names = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'] as const;
  if (names.some(name => !process.env[name]?.trim())) throw new WanError('Private R2 source delivery is not configured.', 503);
  const client = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });
  // Covers the 60-second start timeout and input download; no public ACL or provider upload.
  return getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: fileName }), { expiresIn: 900 });
};
