import type { CreativeCategoryId } from '@/lib/creative-categories';
import type { MediaAsset } from '@/lib/media/types';

export type ReferenceAngleSource = 'ai' | 'manual' | 'legacy' | 'fallback';
export type ReferenceLibraryType = 'layout' | 'tra';

export interface ReferenceLibraryItem extends MediaAsset {
  addedAt: string;
  referenceType: ReferenceLibraryType;
  angle: CreativeCategoryId;
  angleSource: ReferenceAngleSource;
}
