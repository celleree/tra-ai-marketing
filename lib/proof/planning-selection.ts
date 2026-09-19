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
  copy.imageCopy.proofAttribution,
  copy.imageCopy.cta,
  copy.imageCopy.disclosure,
].filter((value): value is string => typeof value === 'string' && value.length > 0);

type ProofToken = {
  key: string;
  numeric: boolean;
  materialNumber: boolean;
};

const canonicalNumericToken = (raw: string) => {
  const percent = raw.endsWith('%');
  const hadCurrency = /^[$€£]/.test(raw);
  const hadGrouping = raw.includes(',');
  let body = raw.replace(/^[$€£]/, '').replace(/%$/, '').replace(/,/g, '');
  const [integerRaw, fractionalRaw] = body.split('.');
  const integer = (integerRaw ?? '').replace(/^0+(?=\d)/, '') || '0';
  const fractional = fractionalRaw?.replace(/0+$/, '');
  body = fractional ? `${integer}.${fractional}` : integer;
  return {
    key: `#${body}${percent ? '%' : ''}`,
    materialNumber: hadCurrency || hadGrouping || percent || integer.length >= 4,
  };
};

const proofTokens = (value: string): ProofToken[] =>
  (value.toLowerCase().match(/[$€£]?\d[\d,]*(?:\.\d+)?%?|[a-z0-9]+(?:['’][a-z0-9]+)*/g) ?? [])
    .map(raw => {
      if (/^[$€£]?\d/.test(raw)) {
        const numeric = canonicalNumericToken(raw);
        return { key: numeric.key, numeric: true, materialNumber: numeric.materialNumber };
      }
      return { key: raw.replace(/’/g, "'"), numeric: false, materialNumber: false };
    });

const COMMON_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'in', 'is', 'it', 'me', 'my',
  'of', 'on', 'or', 'our', 'she', 'that', 'the', 'their', 'them', 'they', 'this',
  'to', 'was', 'we', 'were', 'with', 'you', 'your',
]);

// Short outcome wording can still carry the material meaning of a Proof record.
// Fingerprint these claim-bearing words even when the reused fragment is only
// one or two non-numeric tokens, while leaving generic short overlap alone.
const MATERIAL_CLAIM_TOKENS = new Set([
  'abated', 'abatement', 'eliminated', 'elimination', 'forgiven', 'forgiveness',
  'lowered', 'reduced', 'reduction', 'released', 'resolved', 'resolution',
  'saved', 'savings', 'settled', 'settlement', 'waived', 'waiver',
]);

const MATERIAL_OUTCOME_CONTEXT_TOKENS = new Set([
  'balance', 'balances', 'debt', 'debts', 'garnishment', 'garnishments',
  'interest', 'irs', 'levies', 'levy', 'lien', 'liens', 'penalties', 'penalty',
  'tax', 'taxes',
]);

const SHORT_MATERIAL_OUTCOME_STATES = new Set([
  'clear', 'cleared', 'free', 'gone', 'removed', 'stopped',
]);

const materialPhrase = (tokens: ProofToken[]) => {
  const nonCommon = tokens.filter(token => token.numeric || !COMMON_TOKENS.has(token.key));
  if (nonCommon.length < 2) return false;
  const keys = tokens.filter(token => !token.numeric).map(token => token.key);
  const shortOutcome = keys.some(key => MATERIAL_OUTCOME_CONTEXT_TOKENS.has(key))
    && keys.some(key => SHORT_MATERIAL_OUTCOME_STATES.has(key));
  return shortOutcome
    || tokens.map(token => token.key).join('').replace(/[^a-z0-9]/g, '').length >= 12;
};

const materialFingerprintSet = (value: string) => {
  const tokens = proofTokens(value);
  const fingerprints = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const materialClaim = !token.numeric && MATERIAL_CLAIM_TOKENS.has(token.key);
    if (token.materialNumber || materialClaim) fingerprints.add(`1:${token.key}`);
    if (index + 1 < tokens.length) {
      const pair = [token, tokens[index + 1]];
      if (
        pair.some(item => item.numeric || MATERIAL_CLAIM_TOKENS.has(item.key))
        || materialPhrase(pair)
      ) {
        fingerprints.add(`2:${pair.map(item => item.key).join(' ')}`);
      }
    }
    if (index + 2 < tokens.length) {
      const three = tokens.slice(index, index + 3);
      if (materialPhrase(three)) {
        fingerprints.add(`3:${three.map(token => token.key).join(' ')}`);
      }
    }
    if (index + 3 < tokens.length) {
      const four = tokens.slice(index, index + 4);
      if (materialPhrase(four)) {
        fingerprints.add(`4:${four.map(token => token.key).join(' ')}`);
      }
    }
  }
  return fingerprints;
};

const fieldOverlapsFingerprints = (
  sourceFingerprints: ReadonlySet<string>,
  field: string
) => {
  if (!sourceFingerprints.size) return false;
  for (const token of proofTokens(field)) {
    if (token.numeric && sourceFingerprints.has(`1:${token.key}`)) return true;
  }
  for (const fingerprint of materialFingerprintSet(field)) {
    if (sourceFingerprints.has(fingerprint)) return true;
  }
  return false;
};

const exactTextPresent = (field: string, exactText: string) =>
  field.includes(exactText);

const maskAuthorizedText = (field: string, exactTexts: readonly string[]) => {
  let masked = field;
  for (const text of [...exactTexts].sort((left, right) => right.length - left.length)) {
    if (!text) continue;
    masked = masked.split(text).join(' '.repeat(text.length));
  }
  return masked;
};

const proofSourceTexts = (proof: PlanningProofRecord) => {
  if (proof.type === 'review') {
    return [
      proof.originalReviewText,
      ...(proof.attribution?.allowed === true ? [proof.attribution.display] : []),
    ];
  }
  return [
    proof.approvedClaimWording,
    ...(proof.requiredDisclaimer ? [proof.requiredDisclaimer] : []),
  ];
};

const proofFingerprints = (proof: PlanningProofRecord) => {
  const fingerprints = new Set<string>();
  for (const source of proofSourceTexts(proof)) {
    for (const fingerprint of materialFingerprintSet(source)) fingerprints.add(fingerprint);
  }
  return fingerprints;
};

const exactReviewUnitPresent = (proof: PlanningProofRecord, field: string) =>
  proof.type === 'review'
    && reviewSourceBoundUnits(proof.originalReviewText).some(unit => exactTextPresent(field, unit));

const uniqueAgainst = (
  fingerprints: ReadonlySet<string>,
  excluded: ReadonlySet<string>
) => new Set([...fingerprints].filter(fingerprint => !excluded.has(fingerprint)));

export function validatePlanningProofCopyConsistency(
  selectedProof: SelectedPlanningProof | null,
  proofCatalog: readonly PlanningProofRecord[],
  copy: PlanningProofCopy
) {
  const fields = proofBearingCopyFields(copy);

  if (selectedProof && !fields.some((field) => exactTextPresent(field, selectedProof.selectedText))) {
    throw new Error('Selected Proof text is not present in any ad-facing copy field.');
  }

  const selectedRecord = selectedProof
    ? proofCatalog.find(proof =>
      proof.id === selectedProof.proofId && proof.type === selectedProof.type
    )
    : undefined;
  const selectedReviewAttribution = selectedProof?.type === 'review'
    && selectedRecord?.type === 'review'
    && selectedRecord.attribution?.allowed === true
    ? selectedRecord.attribution.display
    : undefined;
  if (
    selectedReviewAttribution
    && selectedProof?.type === 'review'
    && selectedProof.attribution === undefined
  ) {
    const attributionResidualFields = fields.map(field =>
      maskAuthorizedText(field, [selectedProof.selectedText])
    );
    if (attributionResidualFields.some(field =>
      exactTextPresent(field, selectedReviewAttribution)
    )) {
      throw new Error('Review proof attribution appears in ad-facing copy but was not selected for inclusion.');
    }
  }

  const selectedFingerprints = selectedRecord
    ? proofFingerprints(selectedRecord)
    : new Set<string>();
  const authorizedExactTexts = selectedProof
    ? [
      selectedProof.selectedText,
      ...(selectedProof.type === 'review' && selectedProof.attribution
        ? [selectedProof.attribution]
        : []),
      ...(selectedProof.type === 'case-study' && selectedProof.requiredDisclaimer
        ? [selectedProof.requiredDisclaimer]
        : []),
    ]
    : [];
  const residualFields = fields.map(field => maskAuthorizedText(field, authorizedExactTexts));

  if (selectedRecord) {
    const selectedUnits = selectedRecord.type === 'review'
      ? reviewSourceBoundUnits(selectedRecord.originalReviewText)
      : [];
    for (const field of residualFields) {
      if (
        selectedUnits.some(unit => exactTextPresent(field, unit))
        || fieldOverlapsFingerprints(selectedFingerprints, field)
      ) {
        throw new Error('Ad-facing copy contains additional Proof-derived wording beyond the selected exact text.');
      }
    }
  }

  for (const proof of proofCatalog) {
    if (selectedProof?.proofId === proof.id && selectedProof.type === proof.type) continue;

    const candidateFingerprints = selectedRecord
      ? uniqueAgainst(proofFingerprints(proof), selectedFingerprints)
      : proofFingerprints(proof);

    for (const field of residualFields) {
      const exactReviewUse = exactReviewUnitPresent(proof, field);
      const exactCaseClaimUse = proof.type === 'case-study'
        && exactTextPresent(field, proof.approvedClaimWording);
      const exactDisclaimerUse = proof.type === 'case-study'
        && Boolean(proof.requiredDisclaimer)
        && exactTextPresent(field, proof.requiredDisclaimer!);
      const exactAttributionUse = proof.type === 'review'
        && proof.attribution?.allowed === true
        && exactTextPresent(field, proof.attribution.display);
      const materialUse = fieldOverlapsFingerprints(candidateFingerprints, field);

      if (
        exactReviewUse
        || exactCaseClaimUse
        || exactDisclaimerUse
        || exactAttributionUse
        || materialUse
      ) {
        const kind = proof.type === 'review' ? 'Review' : 'Case Study';
        throw new Error(`Material ad-facing ${kind} text is not bound to the matching Proof selection.`);
      }
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

