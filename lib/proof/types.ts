export type ProofStatus = 'ACTIVE' | 'INACTIVE';

export type ReviewAttribution = {
  display: string;
  allowed: true;
};

export type ProofBase = {
  id: string;
  tags: string[];
  status: ProofStatus;
  createdAt: string;
  updatedAt: string;
};

export type ReviewProofRecord = ProofBase & {
  type: 'review';
  originalReviewText: string;
  source?: string;
  attribution?: ReviewAttribution;
  rating?: number;
};

export type CaseStudyProofRecord = ProofBase & {
  type: 'case-study';
  title: string;
  verifiedFacts: string[];
  approvedClaimWording: string;
  sourceNote: string;
  usageRestrictions?: string;
  requiredDisclaimer?: string;
};

export type ProofRecord = ReviewProofRecord | CaseStudyProofRecord;

export type ReviewProofDraft = Omit<
  ReviewProofRecord,
  keyof ProofBase | 'type'
> & {
  tags?: string[];
};

export type CaseStudyProofDraft = Omit<
  CaseStudyProofRecord,
  keyof ProofBase | 'type'
> & {
  tags?: string[];
};
