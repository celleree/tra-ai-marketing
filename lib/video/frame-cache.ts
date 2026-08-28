import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { detectImageMimeType } from '@/lib/media/storage';
import {
  MAX_REPRESENTATIVE_VIDEO_FRAMES,
  type VideoFrameManifest,
} from '@/lib/video/types';

const DERIVED_PREFIX = 'derived/video-frames';
const MANIFEST_FILE = 'manifest.json';
const HEX_64 = /^[a-f0-9]{64}$/;
const MEDIA_ID = /^media_[a-f0-9]{32}$/;
const FRAME_KEY = /^derived\/video-frames\/media_[a-f0-9]{32}\/[a-f0-9]{64}\/frame-\d{3}\.png$/;

export interface VideoFrameCache {
  readManifest(
    sourceVideoMediaId: string,
    sourceVideoContentHash: string
  ): Promise<VideoFrameManifest | null>;
  readFrame(cacheKey: string): Promise<Buffer | null>;
  writeFrame(cacheKey: string, buffer: Buffer): Promise<void>;
  writeManifest(manifest: VideoFrameManifest): Promise<void>;
}

export const getVideoFrameCachePrefix = (
  sourceVideoMediaId: string,
  sourceVideoContentHash: string
) => {
  if (!MEDIA_ID.test(sourceVideoMediaId) || !HEX_64.test(sourceVideoContentHash)) {
    throw new Error('Invalid TRA video frame-cache identity.');
  }
  return `${DERIVED_PREFIX}/${sourceVideoMediaId}/${sourceVideoContentHash}`;
};

export const getVideoFrameCacheKey = (
  sourceVideoMediaId: string,
  sourceVideoContentHash: string,
  frameIndex: number
) => {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= MAX_REPRESENTATIVE_VIDEO_FRAMES) {
    throw new Error('Invalid TRA video frame index.');
  }
  return `${getVideoFrameCachePrefix(sourceVideoMediaId, sourceVideoContentHash)}/frame-${String(frameIndex).padStart(3, '0')}.png`;
};

const getManifestKey = (
  sourceVideoMediaId: string,
  sourceVideoContentHash: string
) => `${getVideoFrameCachePrefix(sourceVideoMediaId, sourceVideoContentHash)}/${MANIFEST_FILE}`;

const isValidManifest = (
  value: unknown,
  sourceVideoMediaId: string,
  sourceVideoContentHash: string
): value is VideoFrameManifest => {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<VideoFrameManifest>;
  if (
    manifest.version !== 1 ||
    manifest.sourceRole !== 'TRA_VIDEO' ||
    manifest.sourceVideoMediaId !== sourceVideoMediaId ||
    manifest.sourceVideoContentHash !== sourceVideoContentHash ||
    manifest.sourceVideoMimeType !== 'video/mp4' ||
    manifest.sourceVideoFileName !== `${sourceVideoMediaId}.mp4` ||
    typeof manifest.durationMs !== 'number' ||
    !Number.isFinite(manifest.durationMs) ||
    manifest.durationMs <= 0 ||
    !Array.isArray(manifest.frames) ||
    manifest.frames.length < 1 ||
    manifest.frames.length > MAX_REPRESENTATIVE_VIDEO_FRAMES
  ) {
    return false;
  }

  return manifest.frames.every((frame, index) =>
    Boolean(
      frame &&
        frame.frameIndex === index &&
        Number.isInteger(frame.timestampMs) &&
        frame.timestampMs >= 0 &&
        frame.timestampMs <= manifest.durationMs! &&
        frame.mimeType === 'image/png' &&
        typeof frame.cacheKey === 'string' &&
        FRAME_KEY.test(frame.cacheKey) &&
        frame.cacheKey ===
          getVideoFrameCacheKey(
            sourceVideoMediaId,
            sourceVideoContentHash,
            index
          )
    )
  );
};

const parseManifest = (
  buffer: Buffer,
  sourceVideoMediaId: string,
  sourceVideoContentHash: string
): VideoFrameManifest | null => {
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    return isValidManifest(parsed, sourceVideoMediaId, sourceVideoContentHash)
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const validateFrameBuffer = (buffer: Buffer) =>
  detectImageMimeType(buffer) === 'image/png' ? buffer : null;

export class LocalVideoFrameCache implements VideoFrameCache {
  constructor(
    private readonly rootDir = path.join(
      process.env.MEDIA_STORAGE_DIR || path.join(process.cwd(), 'data', 'uploads'),
      '.derived-video-frames'
    )
  ) {}

  private pathForKey(key: string) {
    if (!key.startsWith(`${DERIVED_PREFIX}/`)) {
      throw new Error('Invalid TRA video frame cache key.');
    }
    return path.join(this.rootDir, ...key.split('/').slice(2));
  }

  async readManifest(sourceVideoMediaId: string, sourceVideoContentHash: string) {
    try {
      const buffer = await readFile(
        this.pathForKey(getManifestKey(sourceVideoMediaId, sourceVideoContentHash))
      );
      return parseManifest(buffer, sourceVideoMediaId, sourceVideoContentHash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readFrame(cacheKey: string) {
    if (!FRAME_KEY.test(cacheKey)) {
      throw new Error('Invalid TRA video frame cache key.');
    }
    try {
      return validateFrameBuffer(await readFile(this.pathForKey(cacheKey)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeFrame(cacheKey: string, buffer: Buffer) {
    if (!FRAME_KEY.test(cacheKey) || !validateFrameBuffer(buffer)) {
      throw new Error('Refusing to cache an invalid TRA video frame.');
    }
    const filePath = this.pathForKey(cacheKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
  }

  async writeManifest(manifest: VideoFrameManifest) {
    if (!isValidManifest(manifest, manifest.sourceVideoMediaId, manifest.sourceVideoContentHash)) {
      throw new Error('Refusing to cache an invalid TRA video frame manifest.');
    }
    const filePath = this.pathForKey(
      getManifestKey(manifest.sourceVideoMediaId, manifest.sourceVideoContentHash)
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(manifest));
  }
}

interface R2VideoFrameCacheConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

const isMissingObjectError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; Code?: string; code?: string };
  return [candidate.name, candidate.Code, candidate.code].includes('NoSuchKey');
};

export class R2VideoFrameCache implements VideoFrameCache {
  private readonly client: S3Client;

  constructor(private readonly config: R2VideoFrameCacheConfig) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  private async readObject(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucketName, Key: key })
      );
      if (!response.Body) {
        throw new Error(`R2 returned an empty body for derived video object ${key}.`);
      }
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async readManifest(sourceVideoMediaId: string, sourceVideoContentHash: string) {
    const buffer = await this.readObject(
      getManifestKey(sourceVideoMediaId, sourceVideoContentHash)
    );
    return buffer
      ? parseManifest(buffer, sourceVideoMediaId, sourceVideoContentHash)
      : null;
  }

  async readFrame(cacheKey: string) {
    if (!FRAME_KEY.test(cacheKey)) {
      throw new Error('Invalid TRA video frame cache key.');
    }
    const buffer = await this.readObject(cacheKey);
    return buffer ? validateFrameBuffer(buffer) : null;
  }

  async writeFrame(cacheKey: string, buffer: Buffer) {
    if (!FRAME_KEY.test(cacheKey) || !validateFrameBuffer(buffer)) {
      throw new Error('Refusing to cache an invalid TRA video frame.');
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: cacheKey,
        Body: buffer,
        ContentType: 'image/png',
      })
    );
  }

  async writeManifest(manifest: VideoFrameManifest) {
    if (!isValidManifest(manifest, manifest.sourceVideoMediaId, manifest.sourceVideoContentHash)) {
      throw new Error('Refusing to cache an invalid TRA video frame manifest.');
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: getManifestKey(
          manifest.sourceVideoMediaId,
          manifest.sourceVideoContentHash
        ),
        Body: Buffer.from(JSON.stringify(manifest)),
        ContentType: 'application/json',
      })
    );
  }
}

const getR2Config = (): R2VideoFrameCacheConfig => {
  const config = {
    accountId: process.env.R2_ACCOUNT_ID?.trim() || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || '',
    bucketName: process.env.R2_BUCKET_NAME?.trim() || '',
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error(
      'Production derived video-frame caching requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME.'
    );
  }
  return config;
};

export const getVideoFrameCache = (): VideoFrameCache =>
  process.env.NODE_ENV === 'production'
    ? new R2VideoFrameCache(getR2Config())
    : new LocalVideoFrameCache();
