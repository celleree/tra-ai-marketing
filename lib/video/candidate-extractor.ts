import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import type {
  TemporaryVideoFrameCandidateSet,
  VideoFrameCandidatePolicy,
} from '@/lib/video/candidate-types';

export type HydratedTraVideoSource = HydratedCreativeSourceAsset & {
  role: 'TRA_VIDEO';
};

export interface TraVideoCandidateExtractor {
  extractCandidates(
    source: HydratedTraVideoSource,
    policy?: VideoFrameCandidatePolicy
  ): Promise<TemporaryVideoFrameCandidateSet>;
}
