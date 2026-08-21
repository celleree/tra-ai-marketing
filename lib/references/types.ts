import type { CreativeCategoryId } from '@/lib/creative-categories';
import type { MediaAsset } from '@/lib/media/types';

export type ReferenceAngleSource = 'ai' | 'manual' | 'legacy' | 'fallback';
export type ReferenceOrigin = 'manual' | 'ai-found';

export interface ReferenceDiscoveryMetadata {
  provider: 'apify-meta-ad-library';
  advertiser: string;
  sourceUrl: string;
  adId: string;
  startDate?: string;
  discoveredAt: string;
  searchTerm?: string;
}

export interface ReferenceLibraryItem extends MediaAsset {
  addedAt: string;
  angle: CreativeCategoryId;
  angleSource: ReferenceAngleSource;
  origin?: ReferenceOrigin;
  discovery?: ReferenceDiscoveryMetadata;
}
