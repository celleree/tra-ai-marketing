export interface MetaListItem {
  id: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
}

export interface MetaAdAccount extends MetaListItem {
  currency?: string;
  accountStatus?: number;
}

export const META_CTA_TYPES = [
  'LEARN_MORE',
  'CONTACT_US',
  'APPLY_NOW',
] as const;

export type MetaCtaType = (typeof META_CTA_TYPES)[number];

export interface MetaPublishCreativeInput {
  id: string;
  imageId: string;
  category: string;
  format: string;
  source?: 'generated' | 'uploaded';
  copy: {
    primaryText: string;
    headline: string;
    description: string;
  };
}

export interface MetaPublishCreativeResult {
  creativeId: string;
  status: 'success' | 'failed';
  metaAdId?: string;
  metaCreativeId?: string;
  metaImageHash?: string;
  adStatus?: 'PAUSED';
  ctaType?: MetaCtaType;
  error?: string;
}

export interface MetaPublishBatchResult {
  campaignId: string;
  adSetId: string;
  campaignStatus: 'PAUSED';
  adSetStatus: 'PAUSED';
  objective: 'OUTCOME_TRAFFIC';
  optimizationGoal: 'LANDING_PAGE_VIEWS';
  results: MetaPublishCreativeResult[];
}
