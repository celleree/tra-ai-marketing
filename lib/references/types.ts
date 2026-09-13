import type { CreativeCategoryId } from '@/lib/creative-categories';
import type { MediaAsset } from '@/lib/media/types';

export type ReferenceAngleSource = 'ai' | 'manual' | 'legacy' | 'fallback';
export type ReferenceLibraryType = 'layout' | 'tra';

export interface ReferenceLibraryItem extends MediaAsset, ReferenceCuratedMetadata {
  addedAt: string;
  referenceType: ReferenceLibraryType;
  angle: CreativeCategoryId;
  angleSource: ReferenceAngleSource;
}

export type ReferenceCuratedMetadata = { notes?: string; tags?: string[] };
export const REFERENCE_NOTES_LIMIT = 2000;
export const REFERENCE_TAG_LIMIT = 40;
export const REFERENCE_TAG_COUNT = 10;

/** Optional editorial guidance only; never evidence or human-identity approval. */
export function parseReferenceCuratedMetadata(value: unknown): ReferenceCuratedMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { notes, tags } = value as Record<string, unknown>;
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > REFERENCE_NOTES_LIMIT)) return null;
  if (tags !== undefined && (!Array.isArray(tags) || tags.length > REFERENCE_TAG_COUNT
    || tags.some(tag => typeof tag !== 'string' || tag.length > REFERENCE_TAG_LIMIT))) return null;
  const cleanNotes = (notes as string | undefined)?.trim();
  const cleanTags = [...new Set(((tags ?? []) as string[]).map(tag => tag.trim()).filter(Boolean))];
  return { ...(cleanNotes ? { notes: cleanNotes } : {}), ...(cleanTags.length ? { tags: cleanTags } : {}) };
}
