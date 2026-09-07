import type { CreativeCategoryId } from '@/lib/creative-categories';
import type { CreativeFormatId } from '@/lib/creative-formats';
import type { CreativePlacement } from '@/lib/creatives/placements';
import type { CreativePlanningMetadata } from '@/lib/creatives/planning-metadata';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import type { MediaAsset } from '@/lib/media/types';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import type { CreativeIdentity } from '@/lib/creatives/identity';

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
  placement?: CreativePlacement;
  image: MediaAsset;
  copy: CreativeCopy;
  source?: CreativeSource;
  referenceImageId?: string;
  referenceImageUrl?: string;
  referenceCategory?: CreativeCategoryId;
  referenceSelectionReason?: string;
  videoFrameSelection?: GeneratedVideoFrameSelection;
  planning?: CreativePlanningMetadata;
  generationProvenance?: CreativeGenerationProvenance;
  identity?: CreativeIdentity;
}

export interface CreativeRecord {
  id: string;
  createdAt: string;
  image: MediaAsset;
  category: CreativeCategoryId;
  copy: CreativeCopy;
  format?: CreativeFormatId;
  placement?: CreativePlacement;
  referenceImageId?: string;
  videoFrameSelection?: GeneratedVideoFrameSelection;
  planning?: CreativePlanningMetadata;
  generationProvenance?: CreativeGenerationProvenance;
  identity?: CreativeIdentity;
}
