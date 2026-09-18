import type { PlanningProofRecord } from '@/lib/proof/planning';
import {
  isApprovedCaseStudyClaim,
  requireVerbatimReviewExcerpt,
  reviewSourceBoundUnits,
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
  if (value === null) {
    if (imageProofAttribution !== undefined) {
      throw new Error('Proof attribution requires an attributed Review selection.');
    }
    return null;
  }
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

    if (imageProofAttribution !== undefined) {
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
    if (imageProofAttribution !== undefined) {
      throw new Error('Case Study proof selections cannot include Review attribution.');
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

type PlanningProofCopy = {
  adCopy: {
    primaryText: string;
    headline: string;
    description: string;
  };
  imageCopy: {
    headline: string;
    shortSupport?: string;
    proofAttribution?: string;
    cta?: string;
    disclosure?: string;
  };
};

const proofBearingCopyFields = (copy: PlanningProofCopy) => [
  copy.adCopy.primaryText,
  copy.adCopy.headline,
  copy.adCopy.description,
  copy.imageCopy.headline,
  copy.imageCopy.shortSupport,
  copy.imageCopy.disclosure,
].filter((value): value is string => typeof value === 'string' && value.length > 0);

export function validatePlanningProofCopyConsistency(
  selectedProof: SelectedPlanningProof | null,
  proofCatalog: readonly PlanningProofRecord[],
  copy: PlanningProofCopy
) {
  const fields = proofBearingCopyFields(copy);

  if (selectedProof && !fields.some((field) => field.includes(selectedProof.selectedText))) {
    throw new Error('Selected Proof text is not present in any ad-facing copy field.');
  }

  for (const proof of proofCatalog) {
    if (proof.type === 'review') {
      for (const unit of reviewSourceBoundUnits(proof.originalReviewText)) {
        if (!fields.some((field) => field.includes(unit))) continue;
        if (
          selectedProof?.type !== 'review'
          || selectedProof.proofId !== proof.id
          || !selectedProof.selectedText.includes(unit)
        ) {
          throw new Error('Ad-facing Review text is not bound to the matching Proof selection.');
        }
      }
      continue;
    }

    if (
      fields.some((field) => field.includes(proof.approvedClaimWording))
      && (
        selectedProof?.type !== 'case-study'
        || selectedProof.proofId !== proof.id
        || selectedProof.selectedText !== proof.approvedClaimWording
      )
    ) {
      throw new Error('Ad-facing Case Study wording is not bound to the matching Proof selection.');
    }
  }

  if (
    selectedProof?.type === 'case-study'
    && selectedProof.requiredDisclaimer !== undefined
    && copy.imageCopy.disclosure !== selectedProof.requiredDisclaimer
  ) {
    throw new Error('Selected Case Study requires its canonical disclosure.');
  }
}

