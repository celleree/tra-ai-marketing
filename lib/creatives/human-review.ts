export const CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS = [
  'artifactIntegrity',
  'textReadability',
  'layoutAndHierarchy',
  'imageryAndBrandFit',
  'claimsAndDisclaimers',
  'sourceAndThirdPartyCompliance',
  'conceptDistinctness',
  'placementSafety',
  'logoIntegrity',
  'productionReadiness',
] as const;

export type CreativeHumanReviewChecklistKey =
  (typeof CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS)[number];

export const CREATIVE_HUMAN_REVIEW_CHECKLIST_LABELS: Readonly<
  Record<CreativeHumanReviewChecklistKey, string>
> = {
  artifactIntegrity: 'No obvious AI artifacts or implausible people',
  textReadability: 'Text is accurate and readable',
  layoutAndHierarchy: 'Layout is clear, with no material clutter or spacing problems',
  imageryAndBrandFit: 'Imagery is relevant and fits the TRA brand',
  claimsAndDisclaimers: 'Claims are supported and required disclaimers are present',
  sourceAndThirdPartyCompliance: 'No improper source, third-party identity or branding transfer',
  conceptDistinctness: 'The concept is sufficiently distinct for the intended operation',
  placementSafety: 'Critical content is clear of placement overlays and cropping',
  logoIntegrity: 'The original TRA logo is correct and has a viable placement',
  productionReadiness: 'Ready for use without material designer cleanup',
};

export type CreativeHumanReviewCheck = 'PASS' | 'FAIL';

export type CreativeHumanReviewChecklist = Record<
  CreativeHumanReviewChecklistKey,
  CreativeHumanReviewCheck
>;

export type CreativeHumanReview =
  | { status: 'PENDING' }
  | {
      status: 'APPROVED' | 'REJECTED';
      reviewedAt: string;
      checklist: CreativeHumanReviewChecklist;
      notes?: string;
    };

export interface CreativeLifecycle {
  status: 'ACTIVE' | 'PAUSED';
  updatedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isIsoDate = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

export const parseCreativeHumanReviewChecklist = (
  value: unknown
): CreativeHumanReviewChecklist | null => {
  if (!isRecord(value) || !hasExactKeys(value, CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS)) {
    return null;
  }

  if (
    CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS.some(
      (key) => value[key] !== 'PASS' && value[key] !== 'FAIL'
    )
  ) {
    return null;
  }

  return value as CreativeHumanReviewChecklist;
};

export const parseCreativeHumanReview = (
  value: unknown
): CreativeHumanReview | null => {
  if (!isRecord(value) || typeof value.status !== 'string') return null;

  if (value.status === 'PENDING') {
    return hasExactKeys(value, ['status']) ? { status: 'PENDING' } : null;
  }

  if (
    (value.status !== 'APPROVED' && value.status !== 'REJECTED') ||
    !hasExactKeys(value, value.notes === undefined
      ? ['status', 'reviewedAt', 'checklist']
      : ['status', 'reviewedAt', 'checklist', 'notes']) ||
    !isIsoDate(value.reviewedAt)
  ) {
    return null;
  }

  const checklist = parseCreativeHumanReviewChecklist(value.checklist);
  const notes = typeof value.notes === 'string' ? value.notes.trim() : null;
  if (
    !checklist ||
    (value.notes !== undefined && (!notes || notes.length > 2000))
  ) {
    return null;
  }

  const allPassed = CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS.every(
    (key) => checklist[key] === 'PASS'
  );
  if (
    (value.status === 'APPROVED' && !allPassed) ||
    (value.status === 'REJECTED' && allPassed)
  ) {
    return null;
  }

  return value.notes === undefined
    ? { status: value.status, reviewedAt: value.reviewedAt, checklist }
    : { status: value.status, reviewedAt: value.reviewedAt, checklist, notes: notes! };
};

export const parseCreativeLifecycle = (
  value: unknown
): CreativeLifecycle | null => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status', 'updatedAt']) ||
    (value.status !== 'ACTIVE' && value.status !== 'PAUSED') ||
    !isIsoDate(value.updatedAt)
  ) {
    return null;
  }

  return { status: value.status, updatedAt: value.updatedAt };
};
