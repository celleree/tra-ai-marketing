export type ProofStatus = 'ACTIVE' | 'INACTIVE';

export type ReviewAttribution = {
  display: string;
  allowed: true;
};

export type ProofBase = {
  id: string;
  tags: string[];
  status: ProofStatus;
  advertisingUseApproved?: boolean;
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

export type VideoPassageCandidate = {
  version: 1;
  id: string;
  status: 'PENDING' | 'LINKED' | 'DISMISSED';
  source: {
    locator: { version: 1; sourceVideoMediaId: string; sourceVideoContentHash: string; analyzerFingerprintSha256: string };
    library: { id: string; version: 1 };
  };
  passage: {
    startSegmentIndex: number; endSegmentIndex: number; startMs: number; endMs: number;
    segments: Array<{ segmentIndex: number; startMs: number; endMs: number; text: string }>;
  };
  link?: { proofId: string; proofType: ProofRecord['type']; proofUpdatedAt: string };
  createdAt: string;
  updatedAt: string;
};

export type VideoPassageCandidateLinkHealth = 'UNLINKED' | 'CURRENT' | 'MISSING' | 'CHANGED' | 'INACTIVE' | 'UNAPPROVED';
export type VideoPassageCandidateView = VideoPassageCandidate & { linkHealth: VideoPassageCandidateLinkHealth };

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
