import type { CreativeCategoryId } from '@/lib/creative-categories';
import type { MediaAsset } from '@/lib/media/types';

export type ReferenceAngleSource = 'ai' | 'manual' | 'legacy' | 'fallback';

export interface ReferenceLibraryItem extends MediaAsset {
  addedAt: string;
  angle: CreativeCategoryId;
  angleSource: ReferenceAngleSource;
}
