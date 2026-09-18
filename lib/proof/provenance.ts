import type { CreativeAdCopy, CreativeCopy, CreativeImageCopy } from '@/lib/creatives/generated';
import type { SelectedPlanningProof } from '@/lib/proof/planning-selection';
import { listProofRecords } from '@/lib/proof/storage';
import type { ProofRecord } from '@/lib/proof/types';
import {
  isApprovedCaseStudyClaim,
  isProofId,
  isVerbatimReviewExcerpt,
} from '@/lib/proof/validation';

export type CreativeReviewProofProvenance = {
  version: 1;
  type: 'review';
  proofId: string;
  proofUpdatedAt: string;
  selectedText: string;
  attribution?: string;
};

export type CreativeCaseStudyProofProvenance = {
  version: 1;
  type: 'case-study';
  proofId: string;
  proofUpdatedAt: string;
  selectedText: string;
  usageRestrictions?: string;
  requiredDisclaimer?: string;
};

export type CreativeProofProvenance =
  | CreativeReviewProofProvenance
  | CreativeCaseStudyProofProvenance;

export class ProofRevalidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofRevalidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function parseCreativeProofProvenance(
  value: unknown
): CreativeProofProvenance | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isProofId(value.proofId) ||
    !isIsoDate(value.proofUpdatedAt) ||
    !nonEmptyString(value.selectedText)
  ) {
    return null;
  }

  if (value.type === 'review') {
    const keys = [
      'version',
      'type',
      'proofId',
      'proofUpdatedAt',
      'selectedText',
      ...('attribution' in value ? ['attribution'] : []),
    ];
    return hasOnly(value, keys) &&
      (value.attribution === undefined || nonEmptyString(value.attribution))
      ? {
          version: 1,
          type: 'review',
          proofId: value.proofId,
          proofUpdatedAt: value.proofUpdatedAt,
          selectedText: value.selectedText,
          ...(typeof value.attribution === 'string'
            ? { attribution: value.attribution }
            : {}),
        }
      : null;
  }

  if (value.type === 'case-study') {
    const keys = [
      'version',
      'type',
      'proofId',
      'proofUpdatedAt',
      'selectedText',
      ...('usageRestrictions' in value ? ['usageRestrictions'] : []),
      ...('requiredDisclaimer' in value ? ['requiredDisclaimer'] : []),
    ];
    return hasOnly(value, keys) &&
      (value.usageRestrictions === undefined ||
        nonEmptyString(value.usageRestrictions)) &&
      (value.requiredDisclaimer === undefined ||
        nonEmptyString(value.requiredDisclaimer))
      ? {
          version: 1,
          type: 'case-study',
          proofId: value.proofId,
          proofUpdatedAt: value.proofUpdatedAt,
          selectedText: value.selectedText,
          ...(typeof value.usageRestrictions === 'string'
            ? { usageRestrictions: value.usageRestrictions }
            : {}),
          ...(typeof value.requiredDisclaimer === 'string'
            ? { requiredDisclaimer: value.requiredDisclaimer }
            : {}),
        }
      : null;
  }

  return null;
}

export const proofProvenanceFromSelectedProof = (
  proof: SelectedPlanningProof
): CreativeProofProvenance => ({
  version: 1,
  ...proof,
});

export const selectedProofFromProvenance = (
  provenance: CreativeProofProvenance
): SelectedPlanningProof => {
  const { version: _version, ...proof } = provenance;
  return proof;
};

const ineligible = (reason: string): never => {
  throw new ProofRevalidationError(
    `Selected Proof must be reselected before paid rendering or revision: ${reason}`
  );
};

function validateCurrentProof(
  snapshot: CreativeProofProvenance,
  current: ProofRecord | undefined
) {
  if (!current) return ineligible('the Proof record no longer exists.');
  if (current.status !== 'ACTIVE') return ineligible('the Proof record is inactive.');
  if (current.advertisingUseApproved !== true) {
    return ineligible('advertising use is no longer approved.');
  }
  if (current.updatedAt !== snapshot.proofUpdatedAt) {
    return ineligible('the Proof version changed.');
  }

  if (snapshot.type === 'review') {
    if (current.type !== 'review') return ineligible('the Proof type changed.');
    if (!isVerbatimReviewExcerpt(current.originalReviewText, snapshot.selectedText)) {
      return ineligible('the selected Review excerpt is no longer canonical.');
    }
    if (snapshot.attribution !== undefined &&
      (current.attribution?.allowed !== true || current.attribution.display !== snapshot.attribution)) {
      return ineligible('the Review attribution is no longer permitted.');
    }
    return;
  }

  if (current.type !== 'case-study') return ineligible('the Proof type changed.');
  if (!isApprovedCaseStudyClaim(current.approvedClaimWording, snapshot.selectedText)) {
    return ineligible('the selected Case Study claim is no longer canonical.');
  }
  if (current.usageRestrictions !== snapshot.usageRestrictions) {
    return ineligible('the Case Study usage restrictions changed.');
  }
  if (current.requiredDisclaimer !== snapshot.requiredDisclaimer) {
    return ineligible('the Case Study required disclaimer changed.');
  }
}

export type ProofLinkedCreativeCopy = {
  copy: CreativeCopy;
  adCopy?: CreativeAdCopy;
  imageCopy?: CreativeImageCopy;
};

export function validateCreativeProofCopyConsistency(
  snapshot: CreativeProofProvenance,
  creative: ProofLinkedCreativeCopy
) {
  const adCopy = creative.adCopy ?? creative.copy;
  const imageCopy = creative.imageCopy;
  const proofBearingText = [
    adCopy.primaryText,
    adCopy.headline,
    adCopy.description,
    imageCopy?.headline,
    imageCopy?.shortSupport,
  ];
  if (!proofBearingText.some((value) =>
    typeof value === 'string' && value.includes(snapshot.selectedText))) {
    return ineligible('the creative copy no longer contains the exact selected Proof text.');
  }

  if (snapshot.type === 'review') {
    if (snapshot.attribution !== undefined) {
      if (imageCopy?.proofAttribution !== snapshot.attribution) {
        return ineligible('the creative copy changed or removed the approved Review attribution.');
      }
    } else if (imageCopy?.proofAttribution !== undefined) {
      return ineligible('the creative copy introduced Review attribution that is not authorized by the Proof snapshot.');
    }
    return;
  }

  if (imageCopy?.proofAttribution !== undefined) {
    return ineligible('Case Study Proof cannot carry Review attribution.');
  }
  if (snapshot.requiredDisclaimer !== undefined &&
    imageCopy?.disclosure !== snapshot.requiredDisclaimer) {
    return ineligible('the creative copy changed or removed the required Case Study disclaimer.');
  }
}

export async function revalidateCreativeProofProvenanceForPaidWork(
  snapshot: CreativeProofProvenance
): Promise<CreativeProofProvenance> {
  const current = (await listProofRecords()).find(
    (record) => record.id === snapshot.proofId
  );
  validateCurrentProof(snapshot, current);
  return snapshot;
}

export async function revalidateSelectedProofForPaidWork(
  selectedProof: SelectedPlanningProof | null | undefined
): Promise<CreativeProofProvenance | undefined> {
  if (!selectedProof) return undefined;
  const snapshot = proofProvenanceFromSelectedProof(selectedProof);
  await revalidateCreativeProofProvenanceForPaidWork(snapshot);
  return snapshot;
}
