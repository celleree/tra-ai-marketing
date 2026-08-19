import type { CreativeFormatId } from '@/lib/creative-formats';
import type { MediaAsset } from '@/lib/media/types';

export interface CreativeCopy {
  primaryText: string;
  headline: string;
  description: string;
}

export interface GeneratedCreative {
  index: number;
  primaryFormat: CreativeFormatId;
  secondaryFormat?: CreativeFormatId;
  image: MediaAsset;
  copy: CreativeCopy;
}
