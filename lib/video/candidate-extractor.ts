import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import type {
  CanonicalCreativeSourceMediaAsset,
  StoredCreativeSourceMediaFile,
} from '@/lib/media/types';
import type {
  TemporaryVideoFrameCandidateSet,
  VideoFrameCandidatePolicy,
} from '@/lib/video/candidate-types';

export type HydratedTraVideoSource = HydratedCreativeSourceAsset & {
  role: 'TRA_VIDEO';
  media: Extract<CanonicalCreativeSourceMediaAsset, { mediaType: 'VIDEO' }>;
  stored: Extract<StoredCreativeSourceMediaFile, { mediaType: 'VIDEO' }>;
};

export interface TraVideoCandidateExtractor {
  extractCandidates(
    source: HydratedTraVideoSource,
    policy?: VideoFrameCandidatePolicy
  ): Promise<TemporaryVideoFrameCandidateSet>;
}
