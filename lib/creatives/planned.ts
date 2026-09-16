import type { CreativeFormatId } from '@/lib/creative-formats';
import type {
  CreativeAdCopy,
  CreativeCopy,
  CreativeImageCopy,
} from '@/lib/creatives/generated';
import type { CreativeStrategy } from '@/lib/creatives/strategy';
import type { PortfolioAudit } from '@/lib/creatives/portfolio-audit';

export const MAX_PORTFOLIO_CREATIVES = 36;

export type PlannedCreativeConcept = {
  index: number;
  format: CreativeFormatId;
  /** Backward-compatible Meta ad-copy alias. New plans also persist adCopy explicitly. */
  copy: CreativeCopy;
  adCopy?: CreativeAdCopy;
  imageCopy?: CreativeImageCopy;
  strategy: CreativeStrategy;
  selectionReason: string;
};

export type CreativeBatchPlan = {
  portfolioAudit?: PortfolioAudit;
  creatives: PlannedCreativeConcept[];
  plannerModel: string;
  reasoningEffort: 'medium';
};
