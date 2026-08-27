import {
  getPublicMediaUrl,
  validateStoredMedia,
  type MediaStorage,
} from '@/lib/media/storage';
import {
  isSourceRoleCompatibleWithMedia,
  type CanonicalCreativeSourceAsset,
  type CanonicalCreativeSourceMediaAsset,
  type CreativeSourceSelection,
  type StoredCreativeSourceMediaFile,
  type StoredMediaFile,
} from '@/lib/media/types';

export interface HydratedCreativeSourceAsset
  extends CanonicalCreativeSourceAsset {
  stored: StoredCreativeSourceMediaFile;
}

export interface EligibleProviderImageSource
  extends HydratedCreativeSourceAsset {
  role: 'TRA_REFERENCE';
  media: Extract<CanonicalCreativeSourceMediaAsset, { mediaType: 'IMAGE' }>;
  stored: StoredMediaFile & { mediaType: 'IMAGE' };
}

export class CreativeSourceHydrationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404
  ) {
    super(message);
    this.name = 'CreativeSourceHydrationError';
  }
}

export const hydrateCreativeSourceSelections = async (
  storage: MediaStorage,
  selections: CreativeSourceSelection[]
): Promise<HydratedCreativeSourceAsset[]> => {
  const hydrated: HydratedCreativeSourceAsset[] = [];

  for (const selection of selections) {
    const stored = await storage.readMediaById(selection.mediaId);
    if (!stored) {
      throw new CreativeSourceHydrationError(
        `Source media ${selection.mediaId} could not be found.`,
        404
      );
    }

    try {
      validateStoredMedia(stored);
    } catch (error) {
      throw new CreativeSourceHydrationError(
        error instanceof Error ? error.message : 'The stored source media is invalid.',
        400
      );
    }

    if (!isSourceRoleCompatibleWithMedia(selection.role, stored.mediaType)) {
      throw new CreativeSourceHydrationError(
        'The creative source role does not match the stored media type.',
        400
      );
    }

    const media = {
      id: selection.mediaId,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      mediaType: stored.mediaType,
      size: stored.buffer.byteLength,
      url: getPublicMediaUrl(stored.fileName),
    } as CanonicalCreativeSourceMediaAsset;

    hydrated.push({ role: selection.role, media, stored });
  }

  return hydrated;
};

const isEligibleProviderImageSource = (
  source: HydratedCreativeSourceAsset
): source is EligibleProviderImageSource =>
  source.role === 'TRA_REFERENCE' &&
  source.media.mediaType === 'IMAGE' &&
  source.stored.mediaType === 'IMAGE';

export const findEligibleProviderImageSource = (
  sources: HydratedCreativeSourceAsset[]
) => sources.find(isEligibleProviderImageSource);
