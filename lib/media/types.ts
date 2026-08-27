export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4'] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];
export type AllowedVideoMimeType = (typeof ALLOWED_VIDEO_MIME_TYPES)[number];
export type AllowedMediaMimeType =
  | AllowedImageMimeType
  | AllowedVideoMimeType;

export const CREATIVE_SOURCE_ROLES = [
  'TRA_VIDEO',
  'TRA_REFERENCE',
  'LAYOUT_REFERENCE',
] as const;

export type CreativeSourceRole = (typeof CREATIVE_SOURCE_ROLES)[number];
export type MediaType = 'IMAGE' | 'VIDEO';

export interface MediaAsset {
  id: string;
  fileName: string;
  originalName: string;
  mimeType: AllowedImageMimeType;
  size: number;
  url: string;
}

export interface CreativeSourceImageAsset extends MediaAsset {
  mediaType: 'IMAGE';
}

export interface CreativeSourceVideoAsset {
  id: string;
  fileName: string;
  originalName: string;
  mimeType: AllowedVideoMimeType;
  mediaType: 'VIDEO';
  size: number;
  url: string;
}

export type CreativeSourceMediaAsset =
  | CreativeSourceImageAsset
  | CreativeSourceVideoAsset;

export interface CreativeSourceAsset {
  role: CreativeSourceRole;
  media: CreativeSourceMediaAsset;
}

export interface CreativeSourceSelection {
  mediaId: string;
  role: CreativeSourceRole;
}

export type CanonicalCreativeSourceMediaAsset =
  | {
      id: string;
      fileName: string;
      mimeType: AllowedImageMimeType;
      mediaType: 'IMAGE';
      size: number;
      url: string;
    }
  | {
      id: string;
      fileName: string;
      mimeType: AllowedVideoMimeType;
      mediaType: 'VIDEO';
      size: number;
      url: string;
    };

export interface CanonicalCreativeSourceAsset {
  role: CreativeSourceRole;
  media: CanonicalCreativeSourceMediaAsset;
}

export interface StoredMediaFile {
  fileName: string;
  buffer: Buffer;
  mimeType: AllowedImageMimeType;
}

export type StoredCreativeSourceMediaFile =
  | (StoredMediaFile & { mediaType: 'IMAGE' })
  | {
      fileName: string;
      buffer: Buffer;
      mimeType: AllowedVideoMimeType;
      mediaType: 'VIDEO';
    };

export const isAllowedImageMimeType = (
  value: string
): value is AllowedImageMimeType =>
  ALLOWED_IMAGE_MIME_TYPES.includes(value as AllowedImageMimeType);

export const isAllowedMediaMimeType = (
  value: string
): value is AllowedMediaMimeType =>
  isAllowedImageMimeType(value) ||
  ALLOWED_VIDEO_MIME_TYPES.includes(value as AllowedVideoMimeType);

export const getMediaTypeForMimeType = (
  mimeType: AllowedMediaMimeType
): MediaType => (isAllowedImageMimeType(mimeType) ? 'IMAGE' : 'VIDEO');

export const isCreativeSourceRole = (
  value: string
): value is CreativeSourceRole =>
  CREATIVE_SOURCE_ROLES.includes(value as CreativeSourceRole);

export const isApprovedHumanSourceRole = (role: CreativeSourceRole) =>
  role === 'TRA_VIDEO' || role === 'TRA_REFERENCE';

export const isSourceRoleCompatibleWithMedia = (
  role: CreativeSourceRole,
  mediaType: MediaType
) =>
  role === 'TRA_VIDEO' ? mediaType === 'VIDEO' : mediaType === 'IMAGE';

export const isUsableApprovedHumanSource = (
  source: Pick<CreativeSourceAsset, 'role'>,
  suppliedToImageGeneration: boolean
) => suppliedToImageGeneration && isApprovedHumanSourceRole(source.role);
