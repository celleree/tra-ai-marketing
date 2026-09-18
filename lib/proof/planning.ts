import { listProofRecords } from '@/lib/proof/storage';
import type {
  CaseStudyProofRecord,
  ProofRecord,
  ReviewProofRecord,
} from '@/lib/proof/types';

export const MAX_PLANNING_PROOF_RECORDS = 8;
export const MAX_PLANNING_PROOF_SERIALIZED_CHARS = 32_000;

const USER_DIRECTION_PREFIX = 'USER CREATIVE DIRECTION:\n';
const COMPANY_CONTEXT_MARKER = '\n\nAPPROVED TRA COMPANY CONTEXT:';

export function proofRetrievalQueryFromRequestContext(context: string) {
  if (!context.startsWith(USER_DIRECTION_PREFIX)) return context.trim();
  const end = context.lastIndexOf(COMPANY_CONTEXT_MARKER);
  return context
    .slice(USER_DIRECTION_PREFIX.length, end >= USER_DIRECTION_PREFIX.length ? end : undefined)
    .trim();
}

export type PlanningReviewProof = Pick<
  ReviewProofRecord,
  'id' | 'type' | 'updatedAt' | 'tags' | 'originalReviewText'
> & {
  attribution?: ReviewProofRecord['attribution'];
};

export type PlanningCaseStudyProof = Pick<
  CaseStudyProofRecord,
  | 'id'
  | 'type'
  | 'updatedAt'
  | 'tags'
  | 'title'
  | 'approvedClaimWording'
  | 'usageRestrictions'
  | 'requiredDisclaimer'
>;

export type PlanningProofRecord =
  | PlanningReviewProof
  | PlanningCaseStudyProof;

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'company', 'context', 'creative',
  'creatives', 'direction', 'for', 'from', 'have', 'image', 'images', 'into',
  'meta', 'our', 'plan', 'planning', 'proof', 'reference', 'source', 'static',
  'that', 'the', 'their', 'this', 'tra', 'user', 'was', 'were', 'with', 'you',
  'your',
]);

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const terms = (value: string) =>
  (normalize(value).match(/[a-z0-9]+/g) ?? [])
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));

const overlapCount = (queryTerms: Set<string>, value: string) => {
  const values = new Set(terms(value));
  let count = 0;
  for (const term of queryTerms) if (values.has(term)) count += 1;
  return count;
};

const relevanceScore = (record: ProofRecord, query: string, queryTerms: Set<string>) => {
  if (!queryTerms.size) return 0;
  const normalizedQuery = normalize(query);
  const tagScore = record.tags.reduce((score, tag) => {
    const normalizedTag = normalize(tag);
    const phraseMatch = normalizedTag && normalizedQuery.includes(normalizedTag) ? 20 : 0;
    return score + phraseMatch + overlapCount(queryTerms, tag) * 5;
  }, 0);
  const sourceText = record.type === 'review'
    ? record.originalReviewText
    : [
        record.title,
        record.approvedClaimWording,
        record.usageRestrictions ?? '',
        record.requiredDisclaimer ?? '',
      ].join(' ');
  return tagScore + overlapCount(queryTerms, sourceText);
};

const toPlanningRecord = (record: ProofRecord): PlanningProofRecord =>
  record.type === 'review'
    ? {
        id: record.id,
        type: record.type,
        updatedAt: record.updatedAt,
        tags: [...record.tags],
        originalReviewText: record.originalReviewText,
        ...(record.attribution?.allowed === true
          ? { attribution: { ...record.attribution } }
          : {}),
      }
    : {
        id: record.id,
        type: record.type,
        updatedAt: record.updatedAt,
        tags: [...record.tags],
        title: record.title,
        approvedClaimWording: record.approvedClaimWording,
        ...(record.usageRestrictions
          ? { usageRestrictions: record.usageRestrictions }
          : {}),
        ...(record.requiredDisclaimer
          ? { requiredDisclaimer: record.requiredDisclaimer }
          : {}),
      };

export function selectProofForPlanning(
  records: ProofRecord[],
  query: string
): PlanningProofRecord[] {
  const queryTerms = new Set(terms(query));
  const ranked = records
    .filter(
      (record) =>
        record.status === 'ACTIVE' && record.advertisingUseApproved === true
    )
    .map((record) => ({
      record,
      score: relevanceScore(record, query, queryTerms),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.record.updatedAt) - Date.parse(a.record.updatedAt) ||
        a.record.id.localeCompare(b.record.id)
    );

  const selected: PlanningProofRecord[] = [];
  let serializedChars = 0;
  for (const { record } of ranked) {
    if (selected.length >= MAX_PLANNING_PROOF_RECORDS) break;
    const planningRecord = toPlanningRecord(record);
    const recordChars = JSON.stringify(planningRecord).length;
    if (serializedChars + recordChars > MAX_PLANNING_PROOF_SERIALIZED_CHARS) {
      continue;
    }
    selected.push(planningRecord);
    serializedChars += recordChars;
  }
  return selected;
}

export async function loadPlanningProofCatalog(query: string) {
  return selectProofForPlanning(await listProofRecords(), query);
}
