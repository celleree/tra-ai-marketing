export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export interface MediaAsset {
  id: string;
  fileName: string;
  originalName: string;
  mimeType: AllowedImageMimeType;
  size: number;
  url: string;
}

export interface StoredMediaFile {
  buffer: Buffer;
  mimeType: AllowedImageMimeType;
}
