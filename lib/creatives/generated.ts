import type { CreativeCategoryId } from '@/lib/creative-categories';
import type { CreativeFormatId } from '@/lib/creative-formats';
import type { MediaAsset } from '@/lib/media/types';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';

export interface CreativeCopy {
  primaryText: string;
  headline: string;
  description: string;
}

export type CreativeSource = 'generated' | 'uploaded';

export interface GeneratedCreative {
  id: string;
  index: number;
  category: CreativeCategoryId;
  format: CreativeFormatId;
  image: MediaAsset;
  copy: CreativeCopy;
  source?: CreativeSource;
  referenceImageId?: string;
  referenceImageUrl?: string;
  referenceCategory?: CreativeCategoryId;
  referenceSelectionReason?: string;
  videoFrameSelection?: GeneratedVideoFrameSelection;
}

export interface CreativeRecord {
  id: string;
  createdAt: string;
  image: MediaAsset;
  category: CreativeCategoryId;
  copy: CreativeCopy;
  referenceImageId?: string;
  videoFrameSelection?: GeneratedVideoFrameSelection;
}
