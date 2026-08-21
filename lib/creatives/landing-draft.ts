import type { UploadMode } from '@/lib/creatives/generate-request';
import type { MediaAsset } from '@/lib/media/types';

const STORAGE_KEY = 'tra-ai-marketing:landing-creative-draft';
const MIN_VARIATIONS = 2;
const MAX_VARIATIONS = 30;

export interface LandingCreativeDraft {
  context: string;
  media: MediaAsset | null;
  uploadMode: UploadMode;
  variationCount: number;
  generateOnOpen: boolean;
}

const isMediaAsset = (value: unknown): value is MediaAsset => {
  if (!value || typeof value !== 'object') return false;

  const media = value as Partial<MediaAsset>;
  return Boolean(
    media.id &&
      media.fileName &&
      media.originalName &&
      media.url &&
      typeof media.size === 'number' &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(media.mimeType || '')
  );
};

export function storeLandingCreativeDraft(draft: LandingCreativeDraft) {
  if (typeof window === 'undefined') return;

  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

export function consumeLandingCreativeDraft(): LandingCreativeDraft | null {
  if (typeof window === 'undefined') return null;

  const rawDraft = window.sessionStorage.getItem(STORAGE_KEY);
  if (!rawDraft) return null;

  window.sessionStorage.removeItem(STORAGE_KEY);

  try {
    const parsed = JSON.parse(rawDraft) as Partial<LandingCreativeDraft>;
    if (typeof parsed.context !== 'string' || !parsed.context.trim()) return null;

    const variationCount = Number(parsed.variationCount);
    const uploadMode: UploadMode =
      parsed.uploadMode === 'reference' ? 'reference' : 'tra';

    return {
      context: parsed.context,
      media: isMediaAsset(parsed.media) ? parsed.media : null,
      uploadMode,
      variationCount: Number.isFinite(variationCount)
        ? Math.min(MAX_VARIATIONS, Math.max(MIN_VARIATIONS, variationCount))
        : 4,
      generateOnOpen: parsed.generateOnOpen !== false,
    };
  } catch {
    return null;
  }
}
