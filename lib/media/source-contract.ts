import {
  getMediaTypeForMimeType,
  isAllowedMediaMimeType,
  isCreativeSourceRole,
  isSourceRoleCompatibleWithMedia,
  type AllowedMediaMimeType,
  type CreativeSourceAsset,
  type CreativeSourceSelection,
  type CreativeSourceRole,
  type CreativeSourceMediaAsset,
} from '@/lib/media/types';

const SAFE_MEDIA_ID = /^media_[a-f0-9]{32}$/;
const SAFE_STORED_MEDIA_NAME = /^media_[a-f0-9]{32}\.(png|jpg|webp|mp4)$/;

export type SourceContractResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export const validateSourceRoleForMime = (
  roleValue: unknown,
  mimeTypeValue: unknown
): SourceContractResult<{
  role?: CreativeSourceRole;
  mimeType: AllowedMediaMimeType;
  mediaType: 'IMAGE' | 'VIDEO';
}> => {
  const role = typeof roleValue === 'string' ? roleValue.trim() : '';
  const mimeType = typeof mimeTypeValue === 'string' ? mimeTypeValue : '';

  if (!isAllowedMediaMimeType(mimeType)) {
    return { success: false, error: 'Upload a PNG, JPEG, WebP, or MP4 file.' };
  }

  const mediaType = getMediaTypeForMimeType(mimeType);
  if (!role) {
    return mediaType === 'VIDEO'
      ? {
          success: false,
          error: 'A TRA video upload requires the TRA_VIDEO source role.',
        }
      : { success: true, data: { mimeType, mediaType } };
  }

  if (!isCreativeSourceRole(role)) {
    return { success: false, error: 'The creative source role is invalid.' };
  }
  if (!isSourceRoleCompatibleWithMedia(role, mediaType)) {
    return {
      success: false,
      error: 'The creative source role does not match the uploaded file type.',
    };
  }

  return { success: true, data: { role, mimeType, mediaType } };
};

export const parseCreativeSourceAsset = (
  value: unknown
): SourceContractResult<CreativeSourceAsset> => {
  if (!value || typeof value !== 'object') {
    return { success: false, error: 'sourceAssets contains an invalid source' };
  }

  const source = value as Record<string, unknown>;
  const media =
    source.media && typeof source.media === 'object'
      ? (source.media as Record<string, unknown>)
      : null;
  if (!media) {
    return { success: false, error: 'sourceAssets contains invalid media metadata' };
  }

  const compatibility = validateSourceRoleForMime(
    source.role,
    media.mimeType
  );
  if (!compatibility.success || !compatibility.data.role) {
    return {
      success: false,
      error: compatibility.success
        ? 'sourceAssets contains an invalid role'
        : compatibility.error,
    };
  }

  const id = typeof media.id === 'string' ? media.id.trim() : '';
  const fileName =
    typeof media.fileName === 'string' ? media.fileName.trim() : '';
  const originalName =
    typeof media.originalName === 'string' ? media.originalName.trim() : '';
  const mediaType =
    typeof media.mediaType === 'string' ? media.mediaType : '';
  const size = typeof media.size === 'number' ? media.size : Number(media.size);
  const url = typeof media.url === 'string' ? media.url.trim() : '';

  if (
    !SAFE_MEDIA_ID.test(id) ||
    !SAFE_STORED_MEDIA_NAME.test(fileName) ||
    !fileName.startsWith(`${id}.`)
  ) {
    return { success: false, error: 'sourceAssets contains an invalid media ID' };
  }
  if (!originalName || originalName.length > 200 || !url) {
    return { success: false, error: 'sourceAssets contains invalid provenance metadata' };
  }
  if (mediaType !== compatibility.data.mediaType) {
    return {
      success: false,
      error: 'sourceAssets contains a role or media type mismatch',
    };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { success: false, error: 'sourceAssets contains an invalid file size' };
  }

  return {
    success: true,
    data: {
      role: compatibility.data.role,
      media: {
        id,
        fileName,
        originalName,
        mimeType: compatibility.data.mimeType,
        mediaType: compatibility.data.mediaType,
        size,
        url,
      } as CreativeSourceMediaAsset,
    },
  };
};

export const parseCreativeSourceSelection = (
  value: unknown
): SourceContractResult<CreativeSourceSelection> => {
  if (!value || typeof value !== 'object') {
    return { success: false, error: 'sourceAssets contains an invalid source' };
  }

  const source = value as Record<string, unknown>;
  const mediaId =
    typeof source.mediaId === 'string' ? source.mediaId.trim() : '';
  const role = typeof source.role === 'string' ? source.role.trim() : '';

  if (!SAFE_MEDIA_ID.test(mediaId)) {
    return { success: false, error: 'sourceAssets contains an invalid media ID' };
  }
  if (!isCreativeSourceRole(role)) {
    return { success: false, error: 'sourceAssets contains an invalid role' };
  }
  if (Object.keys(source).some((key) => key !== 'mediaId' && key !== 'role')) {
    return {
      success: false,
      error: 'sourceAssets accepts only mediaId and role',
    };
  }

  return { success: true, data: { mediaId, role } };
};
