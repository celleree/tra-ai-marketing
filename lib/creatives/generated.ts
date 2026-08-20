import type { CreativeCategoryId } from '@/lib/creative-categories';
import type { CreativeFormatId } from '@/lib/creative-formats';
import type { MediaAsset } from '@/lib/media/types';

export interface CreativeCopy {
  primaryText: string;
  headline: string;
  description: string;
}

export interface GeneratedCreative {
  id: string;
  index: number;
  category: CreativeCategoryId;
  format: CreativeFormatId;
  image: MediaAsset;
  copy: CreativeCopy;
}
