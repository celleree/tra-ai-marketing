import { randomUUID } from 'crypto';
import { basename } from 'path';
import {
  getMediaTypeForMimeType,
  isAllowedImageMimeType,
  isAllowedMediaMimeType,
  type AllowedImageMimeType,
  type AllowedMediaMimeType,
  type CreativeSourceMediaAsset,
  type MediaAsset,
  type StoredCreativeSourceMediaFile,
  type StoredMediaFile,
} from '@/lib/media/types';

export { isAllowedImageMimeType };

export const EXTENSION_BY_MIME: Record<AllowedMediaMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

export const MIME_BY_EXTENSION: Record<string, AllowedMediaMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

const SAFE_MEDIA_ID = /^media_[a-f0-9]{32}$/;
const SAFE_STORED_NAME = /^media_[a-f0-9]{32}\.(png|jpg|webp|mp4)$/;
const DEFAULT_MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export interface MediaStorage {
  saveMedia(file: File): Promise<CreativeSourceMediaAsset>;
  readMedia(fileName: string): Promise<StoredCreativeSourceMediaFile | null>;
  readMediaById(mediaId: string): Promise<StoredCreativeSourceMediaFile | null>;
  saveImage(file: File): Promise<MediaAsset>;
  readImage(fileName: string): Promise<StoredMediaFile | null>;
  readImageById(mediaId: string): Promise<StoredMediaFile | null>;
  deleteImage(fileName: string): Promise<void>;
}

export type PreparedMedia = CreativeSourceMediaAsset & { buffer: Buffer };
export type PreparedMediaImage = MediaAsset & { buffer: Buffer };

const hasPrefix = (buffer: Buffer, prefix: number[]) =>
  prefix.every((byte, index) => buffer[index] === byte);

const SUPPORTED_MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'iso7',
  'iso8',
  'iso9',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'MSNV',
  'dash',
]);

const UNSUPPORTED_IMAGE_OR_MOV_BRANDS = new Set([
  'qt  ',
  'avif',
  'avis',
  'heic',
  'heix',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);

const readIsoBoxEnd = (buffer: Buffer, offset: number) => {
  if (offset + 8 > buffer.length) return null;

  const size32 = buffer.readUInt32BE(offset);
  if (size32 === 0) return buffer.length;
  if (size32 === 1) {
    if (offset + 16 > buffer.length) return null;
    const size64 = buffer.readBigUInt64BE(offset + 8);
    if (size64 < BigInt(16) || size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    const end = offset + Number(size64);
    return end <= buffer.length ? end : null;
  }
  if (size32 < 8) return null;

  const end = offset + size32;
  return end <= buffer.length ? end : null;
};

export const isSupportedMp4Container = (buffer: Buffer) => {
  if (buffer.length < 32 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    return false;
  }

  const ftypEnd = readIsoBoxEnd(buffer, 0);
  if (!ftypEnd || ftypEnd < 16 || (ftypEnd - 16) % 4 !== 0) return false;

  const majorBrand = buffer.subarray(8, 12).toString('ascii');
  if (UNSUPPORTED_IMAGE_OR_MOV_BRANDS.has(majorBrand)) return false;

  const brands = [majorBrand];
  for (let offset = 16; offset < ftypEnd; offset += 4) {
    brands.push(buffer.subarray(offset, offset + 4).toString('ascii'));
  }
  if (!brands.some((brand) => SUPPORTED_MP4_BRANDS.has(brand))) return false;

  let offset = 0;
  let hasMovieMetadata = false;
  let hasMediaData = false;
  while (offset < buffer.length) {
    const end = readIsoBoxEnd(buffer, offset);
    if (!end || end <= offset) return false;

    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const boxSize = end - offset;
    hasMovieMetadata ||= (type === 'moov' || type === 'moof') && boxSize > 8;
    hasMediaData ||= type === 'mdat' && boxSize > 8;
    offset = end;
  }

  return offset === buffer.length && hasMovieMetadata && hasMediaData;
};

export const detectMediaMimeType = (
  buffer: Buffer
): AllowedMediaMimeType | null => {
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
  if (isSupportedMp4Container(buffer)) {
    return 'video/mp4';
  }
  return null;
};

export const detectImageMimeType = (
  buffer: Buffer
): AllowedImageMimeType | null => {
  const mimeType = detectMediaMimeType(buffer);
  return mimeType && isAllowedImageMimeType(mimeType) ? mimeType : null;
};

const configuredMaxBytes = (name: string, fallback: number) => {
  const configured = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
};

export const getMaxUploadBytes = (
  mimeType: AllowedMediaMimeType = 'image/png'
) =>
  getMediaTypeForMimeType(mimeType) === 'VIDEO'
    ? configuredMaxBytes('MAX_VIDEO_UPLOAD_BYTES', DEFAULT_MAX_VIDEO_UPLOAD_BYTES)
    : configuredMaxBytes('MAX_UPLOAD_BYTES', DEFAULT_MAX_IMAGE_UPLOAD_BYTES);

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

export const validateStoredMedia = (stored: StoredCreativeSourceMediaFile) => {
  if (stored.buffer.length > getMaxUploadBytes(stored.mimeType)) {
    throw new MediaValidationError(
      `The ${stored.mediaType === 'VIDEO' ? 'video' : 'image'} is larger than the upload limit.`
    );
  }

  if (detectMediaMimeType(stored.buffer) !== stored.mimeType) {
    throw new MediaValidationError(
      'The file contents do not match a supported PNG, JPEG, WebP, or MP4 file.'
    );
  }
};

export const validateStoredMediaImage = (stored: StoredMediaFile) =>
  validateStoredMedia({ ...stored, mediaType: 'IMAGE' });

export const prepareMedia = async (file: File): Promise<PreparedMedia> => {
  if (!file.size) {
    throw new MediaValidationError('The uploaded file is empty.');
  }
  if (!isAllowedMediaMimeType(file.type)) {
    throw new MediaValidationError('Upload a PNG, JPEG, WebP, or MP4 file.');
  }
  if (file.size > getMaxUploadBytes(file.type)) {
    throw new MediaValidationError(
      `The ${getMediaTypeForMimeType(file.type) === 'VIDEO' ? 'video' : 'image'} is larger than the upload limit.`
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detectedMimeType = detectMediaMimeType(buffer);
  if (!detectedMimeType || detectedMimeType !== file.type) {
    throw new MediaValidationError(
      'The file contents do not match a supported PNG, JPEG, WebP, or MP4 file.'
    );
  }

  const id = `media_${randomUUID().replaceAll('-', '')}`;
  const fileName = `${id}.${EXTENSION_BY_MIME[detectedMimeType]}`;
  return {
    id,
    fileName,
    originalName: basename(file.name || 'upload').slice(0, 200),
    mimeType: detectedMimeType,
    mediaType: getMediaTypeForMimeType(detectedMimeType),
    size: file.size,
    url: getPublicMediaUrl(fileName),
    buffer,
  } as PreparedMedia;
};

export const prepareMediaImage = async (
  file: File
): Promise<PreparedMediaImage> => {
  if (!isAllowedImageMimeType(file.type)) {
    throw new MediaValidationError('Upload a PNG, JPEG, or WebP image.');
  }
  const { mediaType: _mediaType, ...prepared } = await prepareMedia(file);
  return prepared as PreparedMediaImage;
};

export const getStoredMediaMimeType = (
  fileName: string
): AllowedMediaMimeType | null => {
  const match = SAFE_STORED_NAME.exec(fileName);
  return match ? MIME_BY_EXTENSION[match[1]] || null : null;
};

export const getStoredImageMimeType = (
  fileName: string
): AllowedImageMimeType | null => {
  const mimeType = getStoredMediaMimeType(fileName);
  return mimeType && isAllowedImageMimeType(mimeType) ? mimeType : null;
};

export const isSafeMediaId = (mediaId: string) => SAFE_MEDIA_ID.test(mediaId);
