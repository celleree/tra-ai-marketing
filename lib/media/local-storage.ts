import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, resolve } from 'path';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  type AllowedImageMimeType,
  type MediaAsset,
  type StoredMediaFile,
} from '@/lib/media/types';
import { MediaValidationError, type MediaStorage } from '@/lib/media/storage';

const EXTENSION_BY_MIME: Record<AllowedImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const MIME_BY_EXTENSION: Record<string, AllowedImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

const SAFE_MEDIA_ID = /^media_[a-f0-9]{32}$/;
const SAFE_STORED_NAME = /^media_[a-f0-9]{32}\.(png|jpg|webp)$/;
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const isAllowedMimeType = (value: string): value is AllowedImageMimeType =>
  ALLOWED_IMAGE_MIME_TYPES.includes(value as AllowedImageMimeType);

const hasPrefix = (buffer: Buffer, prefix: number[]) =>
  prefix.every((byte, index) => buffer[index] === byte);

const detectImageMimeType = (buffer: Buffer): AllowedImageMimeType | null => {
  if (
    buffer.length >= 8 &&
    hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return 'image/png';
  }

  if (buffer.length >= 3 && hasPrefix(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
};

const getMaxUploadBytes = () => {
  const configured = Number.parseInt(process.env.MAX_UPLOAD_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_BYTES;
};

export class LocalMediaStorage implements MediaStorage {
  private readonly root = resolve(
    process.cwd(),
    process.env.MEDIA_STORAGE_DIR || 'data/uploads'
  );

  async saveImage(file: File): Promise<MediaAsset> {
    if (!file.size) {
      throw new MediaValidationError('The uploaded image is empty.');
    }

    if (file.size > getMaxUploadBytes()) {
      throw new MediaValidationError('The image is larger than the upload limit.');
    }

    if (!isAllowedMimeType(file.type)) {
      throw new MediaValidationError('Upload a PNG, JPEG, or WebP image.');
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const detectedMimeType = detectImageMimeType(buffer);

    if (!detectedMimeType || detectedMimeType !== file.type) {
      throw new MediaValidationError(
        'The file contents do not match a supported PNG, JPEG, or WebP image.'
      );
    }

    await mkdir(this.root, { recursive: true });

    const id = `media_${randomUUID().replaceAll('-', '')}`;
    const extension = EXTENSION_BY_MIME[detectedMimeType];
    const fileName = `${id}.${extension}`;

    await writeFile(resolve(this.root, fileName), buffer, { flag: 'wx' });

    return {
      id,
      fileName,
      originalName: basename(file.name || 'upload').slice(0, 200),
      mimeType: detectedMimeType,
      size: file.size,
      url: `/api/media/files/${fileName}`,
    };
  }

  async readImage(fileName: string): Promise<StoredMediaFile | null> {
    const match = SAFE_STORED_NAME.exec(fileName);
    if (!match) {
      return null;
    }

    const mimeType = MIME_BY_EXTENSION[match[1]];
    if (!mimeType) {
      return null;
    }

    try {
      const buffer = await readFile(resolve(this.root, fileName));
      return { fileName, buffer, mimeType };
    } catch {
      return null;
    }
  }

  async readImageById(mediaId: string): Promise<StoredMediaFile | null> {
    if (!SAFE_MEDIA_ID.test(mediaId)) {
      return null;
    }

    for (const extension of Object.keys(MIME_BY_EXTENSION)) {
      const stored = await this.readImage(`${mediaId}.${extension}`);
      if (stored) {
        return stored;
      }
    }

    return null;
  }
}

let storage: MediaStorage | undefined;

export const getMediaStorage = (): MediaStorage => {
  storage ||= new LocalMediaStorage();
  return storage;
};
