import type { CreativeFormatId } from '@/lib/creative-formats';
import type { CreativeCopy } from '@/lib/creatives/generated';
import type { CreativeStrategy } from '@/lib/creatives/strategy';
import type { PortfolioAudit } from '@/lib/creatives/portfolio-audit';

export type PlannedCreativeConcept = {
  index: number;
  format: CreativeFormatId;
  copy: CreativeCopy;
  strategy: CreativeStrategy;
  selectionReason: string;
};

export type CreativeBatchPlan = {
  portfolioAudit?: PortfolioAudit;
  creatives: PlannedCreativeConcept[];
  plannerModel: string;
  reasoningEffort: 'medium';
};
