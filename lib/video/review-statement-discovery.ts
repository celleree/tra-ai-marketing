import { listProofRecords } from '@/lib/proof/storage';
import type { ProofRecord } from '@/lib/proof/types';
import { COMPANY_PROFILE_STORAGE_KEY } from '@/lib/company/creative-context';
import { KNOWLEDGE_BASE_FIELDS } from '@/lib/company/profile';
import { hydrateReviewClaim } from '@/lib/video/review-selection-sources';
import { parseReviewSelectionChoices, reviewSourceSha256, type ReviewClaimReference } from '@/lib/video/review-selection';

/** Exact source fields for draft guidance. Discovery neither saves nor grants advertising approval. */
export async function discoverReviewStatements(companyProfile: unknown,
  dependencies: { proofs?: () => Promise<ProofRecord[]> } = {}) {
  const choices = parseReviewSelectionChoices({ video: null, frames: null, claims: null, companyProfile });
  const proofs = await (dependencies.proofs ?? listProofRecords)();
  const references: ReviewClaimReference[] = proofs.filter(record => record.status === 'ACTIVE').flatMap(record => {
    const fields = record.type === 'review' ? [{ field: 'originalReviewText' as const, text: record.originalReviewText, factIndex: null }]
      : [{ field: 'approvedClaimWording' as const, text: record.approvedClaimWording, factIndex: null },
        ...record.verifiedFacts.map((text, factIndex) => ({ field: 'verifiedFacts' as const, text, factIndex }))];
    return fields.filter(item => item.text.trim()).map(item => ({ type: 'PROOF' as const, proofId: record.id, proofType: record.type,
      proofUpdatedAt: record.updatedAt, recordSha256: reviewSourceSha256(record), field: item.field, factIndex: item.factIndex,
      start: 0, end: item.text.length }));
  });
  if (choices.companyProfile) for (const field of KNOWLEDGE_BASE_FIELDS) {
    const text = choices.companyProfile.knowledgeBase?.[field.key];
    if (text?.trim()) references.push({ type: 'COMPANY_PROFILE', profileVersion: COMPANY_PROFILE_STORAGE_KEY,
      profileSha256: reviewSourceSha256(choices.companyProfile), section: 'knowledgeBase', field: field.key, start: 0, end: text.length });
  }
  return { companyProfile: choices.companyProfile, statements: references.map(reference => hydrateReviewClaim(reference, choices, null, proofs)) };
}
