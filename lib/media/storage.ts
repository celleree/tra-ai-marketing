import { randomUUID } from 'crypto';
import { basename } from 'path';
import type { MediaAsset, StoredMediaFile } from '@/lib/media/types';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  type AllowedImageMimeType,
} from '@/lib/media/types';

export const EXTENSION_BY_MIME: Record<AllowedImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const MIME_BY_EXTENSION: Record<string, AllowedImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

const SAFE_MEDIA_ID = /^media_[a-f0-9]{32}$/;
const SAFE_STORED_NAME = /^media_[a-f0-9]{32}\.(png|jpg|webp)$/;
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export interface MediaStorage {
  saveImage(file: File): Promise<MediaAsset>;
  readImage(fileName: string): Promise<StoredMediaFile | null>;
  readImageById(mediaId: string): Promise<StoredMediaFile | null>;
  deleteImage(fileName: string): Promise<void>;
}

export interface PreparedMediaImage extends MediaAsset {
  buffer: Buffer;
}

export const isAllowedImageMimeType = (
  value: string
): value is AllowedImageMimeType =>
  ALLOWED_IMAGE_MIME_TYPES.includes(value as AllowedImageMimeType);

const hasPrefix = (buffer: Buffer, prefix: number[]) =>
  prefix.every((byte, index) => buffer[index] === byte);

export const detectImageMimeType = (
  buffer: Buffer
): AllowedImageMimeType | null => {
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

export const getMaxUploadBytes = () => {
  const configured = Number.parseInt(process.env.MAX_UPLOAD_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_BYTES;
};

const getConfiguredPublicBaseUrl = () => {
  const configured =
    process.env.CREATIVE_PUBLIC_BASE_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    '';

  if (!configured) return '';

  const candidate = /^https?:\/\//i.test(configured)
    ? configured
    : `https://${configured}`;

  try {
    return new URL(candidate).origin;
  } catch {
    return '';
  }
};

export const getPublicMediaUrl = (fileName: string) => {
  const path = `/api/media/files/${fileName}`;
  const baseUrl = getConfiguredPublicBaseUrl();
  return baseUrl ? new URL(path, baseUrl).toString() : path;
};

export const validateStoredMediaImage = (stored: StoredMediaFile) => {
  if (stored.buffer.length > getMaxUploadBytes()) {
    throw new MediaValidationError('The image is larger than the upload limit.');
  }

  const detectedMimeType = detectImageMimeType(stored.buffer);
  if (!detectedMimeType || detectedMimeType !== stored.mimeType) {
    throw new MediaValidationError(
      'The file contents do not match a supported PNG, JPEG, or WebP image.'
    );
  }
};

export const prepareMediaImage = async (
  file: File
): Promise<PreparedMediaImage> => {
  if (!file.size) {
    throw new MediaValidationError('The uploaded image is empty.');
  }

  if (file.size > getMaxUploadBytes()) {
    throw new MediaValidationError('The image is larger than the upload limit.');
  }

  if (!isAllowedImageMimeType(file.type)) {
    throw new MediaValidationError('Upload a PNG, JPEG, or WebP image.');
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detectedMimeType = detectImageMimeType(buffer);

  if (!detectedMimeType || detectedMimeType !== file.type) {
    throw new MediaValidationError(
      'The file contents do not match a supported PNG, JPEG, or WebP image.'
    );
  }

  const id = `media_${randomUUID().replaceAll('-', '')}`;
  const fileName = `${id}.${EXTENSION_BY_MIME[detectedMimeType]}`;

  return {
    id,
    fileName,
    originalName: basename(file.name || 'upload').slice(0, 200),
    mimeType: detectedMimeType,
    size: file.size,
    url: getPublicMediaUrl(fileName),
    buffer,
  };
};

export const getStoredImageMimeType = (
  fileName: string
): AllowedImageMimeType | null => {
  const match = SAFE_STORED_NAME.exec(fileName);
  return match ? MIME_BY_EXTENSION[match[1]] || null : null;
};

export const isSafeMediaId = (mediaId: string) => SAFE_MEDIA_ID.test(mediaId);
