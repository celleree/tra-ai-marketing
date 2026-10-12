import { parseCreativeIdentity, type CreativeIdentity } from '@/lib/creatives/identity';

/** Learning acceptance is separate from creative approval and never authorizes generation. */
export type LearningReview = { status: 'PENDING' }
  | { status: 'ACCEPTED' | 'REJECTED'; reviewerId: string; reviewedAt: string; notes: string };
export type ExperimentLearningRecord = {
  version: 1;
  id: string;
  createdAt: string;
  creativeId: string;
  identity: CreativeIdentity;
  evidenceReferences: string[];
  observedOutcome: string;
  causalHypothesis: string | null;
  recommendation: string;
  financialOutcome: 'unknown';
  review: LearningReview;
};
export type LearningEvidenceState = {
  reference: string;
  status: 'AVAILABLE' | 'MISSING' | 'STALE' | 'REJECTED';
};

const shape = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => key in value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 2000;
const instant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
};

/** Pure shape validation; free-text causal hypotheses remain unverified and require human review. */
export function parseExperimentLearningRecord(value: unknown): ExperimentLearningRecord | null {
  if (!shape(value, ['version', 'id', 'createdAt', 'creativeId', 'identity', 'evidenceReferences',
    'observedOutcome', 'causalHypothesis', 'recommendation', 'financialOutcome', 'review'])
    || value.version !== 1 || typeof value.id !== 'string' || !/^learning_[a-f0-9]{32}$/.test(value.id)
    || !instant(value.createdAt) || typeof value.creativeId !== 'string'
    || !Array.isArray(value.evidenceReferences) || !value.evidenceReferences.length || value.evidenceReferences.length > 50
    || !value.evidenceReferences.every(item => text(item)) || new Set(value.evidenceReferences).size !== value.evidenceReferences.length
    || !text(value.observedOutcome) || (value.causalHypothesis !== null && !text(value.causalHypothesis))
    || !text(value.recommendation) || value.financialOutcome !== 'unknown') return null;
  const identity = parseCreativeIdentity(value.identity, value.creativeId);
  if (!identity) return null;
  let review: LearningReview;
  if (shape(value.review, ['status']) && value.review.status === 'PENDING') review = { status: 'PENDING' };
  else {
    if (!shape(value.review, ['status', 'reviewerId', 'reviewedAt', 'notes'])
      || (value.review.status !== 'ACCEPTED' && value.review.status !== 'REJECTED') || !text(value.review.reviewerId)
      || !instant(value.review.reviewedAt) || Date.parse(value.review.reviewedAt) < Date.parse(value.createdAt)
      || !text(value.review.notes)) return null;
    review = { status: value.review.status, reviewerId: value.review.reviewerId, reviewedAt: value.review.reviewedAt, notes: value.review.notes };
  }
  return { version: 1, id: value.id, createdAt: value.createdAt, creativeId: value.creativeId, identity,
    evidenceReferences: [...value.evidenceReferences], observedOutcome: value.observedOutcome,
    causalHypothesis: value.causalHypothesis, recommendation: value.recommendation, financialOutcome: 'unknown', review };
}

/** Caller assesses evidence freshness/approval; no implicit TTL, financial lift or automatic prompt changes. */
export function selectAcceptedLearningRecords(records: unknown, evidence: unknown): ExperimentLearningRecord[] {
  if (!Array.isArray(records) || records.length > 100 || !Array.isArray(evidence) || evidence.length > 1000) return [];
  const available = new Set<string>(), seen = new Set<string>();
  for (const item of evidence) {
    if (!shape(item, ['reference', 'status']) || !text(item.reference) || typeof item.status !== 'string'
      || !['AVAILABLE', 'MISSING', 'STALE', 'REJECTED'].includes(item.status) || seen.has(item.reference)) return [];
    seen.add(item.reference);
    if (item.status === 'AVAILABLE') available.add(item.reference);
  }
  const parsed = records.map(parseExperimentLearningRecord);
  const counts = new Map<string, number>();
  for (const item of parsed) if (item) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return parsed.filter((item): item is ExperimentLearningRecord => item !== null && item.review.status === 'ACCEPTED'
    && counts.get(item.id) === 1 && item.evidenceReferences.every(ref => available.has(ref)));
}
