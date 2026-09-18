import type { PlanningProofRecord } from '@/lib/proof/planning';
import {
  isApprovedCaseStudyClaim,
  requireVerbatimReviewExcerpt,
} from '@/lib/proof/validation';

export type SelectedReviewProof = {
  type: 'review';
  proofId: string;
  proofUpdatedAt: string;
  selectedText: string;
  attribution?: string;
};

export type SelectedCaseStudyProof = {
  type: 'case-study';
  proofId: string;
  proofUpdatedAt: string;
  selectedText: string;
  usageRestrictions?: string;
  requiredDisclaimer?: string;
};

export type SelectedPlanningProof =
  | SelectedReviewProof
  | SelectedCaseStudyProof;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const proofId = (value: unknown): value is string =>
  typeof value === 'string' && /^proof_[a-f0-9]{32}$/.test(value);

const isoDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

export function hydratePlanningProofSelection(
  value: unknown,
  proofCatalog: readonly PlanningProofRecord[],
  imageProofAttribution?: string
): SelectedPlanningProof | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Proof selection is malformed.');
  }

  if (value.type === 'review') {
    if (!hasOnly(value, [
      'type',
      'proofId',
      'proofUpdatedAt',
      'selectedText',
      'includeAttribution',
    ]) || typeof value.proofId !== 'string'
      || typeof value.proofUpdatedAt !== 'string'
      || typeof value.selectedText !== 'string'
      || typeof value.includeAttribution !== 'boolean') {
      throw new Error('Review proof selection is malformed.');
    }
    const proof = proofCatalog.find((item) => item.id === value.proofId);
    if (!proof || proof.type !== 'review' || proof.updatedAt !== value.proofUpdatedAt) {
      throw new Error('Review proof selection is unknown, stale, or wrong-type.');
    }
    const selectedText = requireVerbatimReviewExcerpt(
      proof.originalReviewText,
      value.selectedText
    );

    if (value.includeAttribution) {
      if (proof.attribution?.allowed !== true) {
        throw new Error('Review proof attribution is not approved.');
      }
      if (imageProofAttribution !== proof.attribution.display) {
        throw new Error('Review proof attribution must match canonical approved text.');
      }
      return {
        type: 'review',
        proofId: proof.id,
        proofUpdatedAt: proof.updatedAt,
        selectedText,
        attribution: proof.attribution.display,
      };
    }

    if (
      proof.attribution?.allowed === true
      && imageProofAttribution === proof.attribution.display
    ) {
      throw new Error('Review proof attribution was not selected for inclusion.');
    }
    return {
      type: 'review',
      proofId: proof.id,
      proofUpdatedAt: proof.updatedAt,
      selectedText,
    };
  }

  if (value.type === 'case-study') {
    if (!hasOnly(value, ['type', 'proofId', 'proofUpdatedAt', 'selectedText'])
      || typeof value.proofId !== 'string'
      || typeof value.proofUpdatedAt !== 'string'
      || typeof value.selectedText !== 'string') {
      throw new Error('Case Study proof selection is malformed.');
    }
    const proof = proofCatalog.find((item) => item.id === value.proofId);
    if (!proof || proof.type !== 'case-study' || proof.updatedAt !== value.proofUpdatedAt) {
      throw new Error('Case Study proof selection is unknown, stale, or wrong-type.');
    }
    if (!isApprovedCaseStudyClaim(proof.approvedClaimWording, value.selectedText)) {
      throw new Error('Case Study proof selection must use exact approved wording.');
    }
    return {
      type: 'case-study',
      proofId: proof.id,
      proofUpdatedAt: proof.updatedAt,
      selectedText: proof.approvedClaimWording,
      ...(proof.usageRestrictions
        ? { usageRestrictions: proof.usageRestrictions }
        : {}),
      ...(proof.requiredDisclaimer
        ? { requiredDisclaimer: proof.requiredDisclaimer }
        : {}),
    };
  }

  throw new Error('Proof selection type is unsupported.');
}

export function isSelectedPlanningProof(value: unknown): value is SelectedPlanningProof {
  if (!isRecord(value) || !proofId(value.proofId) || !isoDate(value.proofUpdatedAt)
    || !nonEmptyString(value.selectedText)) return false;

  if (value.type === 'review') {
    const keys = ['type', 'proofId', 'proofUpdatedAt', 'selectedText',
      ...('attribution' in value ? ['attribution'] : [])];
    return hasOnly(value, keys)
      && (value.attribution === undefined || nonEmptyString(value.attribution));
  }

  if (value.type === 'case-study') {
    const keys = ['type', 'proofId', 'proofUpdatedAt', 'selectedText',
      ...('usageRestrictions' in value ? ['usageRestrictions'] : []),
      ...('requiredDisclaimer' in value ? ['requiredDisclaimer'] : [])];
    return hasOnly(value, keys)
      && (value.usageRestrictions === undefined || nonEmptyString(value.usageRestrictions))
      && (value.requiredDisclaimer === undefined || nonEmptyString(value.requiredDisclaimer));
  }

  return false;
}
