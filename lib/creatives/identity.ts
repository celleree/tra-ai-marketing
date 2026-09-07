export const CREATIVE_IDENTITY_OPERATIONS = [
  'GENERATE',
  'PLACEMENT',
  'EDIT',
  'REGENERATE',
  'VARIATION',
] as const;

export type CreativeIdentityOperation =
  (typeof CREATIVE_IDENTITY_OPERATIONS)[number];

export type CreativeIdentity = {
  conceptId: string;
  parentCreativeId: string | null;
  operation: CreativeIdentityOperation;
  fingerprint: string;
};

export type CreativeIdentityParent = {
  id: string;
  identity?: unknown;
};

const SAFE_CREATIVE_ID = /^creative_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTITY_FIELDS = [
  'conceptId',
  'parentCreativeId',
  'operation',
  'fingerprint',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isOperation = (value: unknown): value is CreativeIdentityOperation =>
  typeof value === 'string' &&
  CREATIVE_IDENTITY_OPERATIONS.some((operation) => operation === value);

export function parseCreativeIdentity(
  value: unknown,
  currentCreativeId: string
): CreativeIdentity | null {
  if (
    !SAFE_CREATIVE_ID.test(currentCreativeId) ||
    !isRecord(value) ||
    Object.keys(value).length !== IDENTITY_FIELDS.length ||
    !IDENTITY_FIELDS.every((field) => field in value) ||
    typeof value.conceptId !== 'string' ||
    !SAFE_CREATIVE_ID.test(value.conceptId) ||
    !isOperation(value.operation) ||
    typeof value.fingerprint !== 'string' ||
    !SHA256.test(value.fingerprint)
  ) {
    return null;
  }

  const parentCreativeId = value.parentCreativeId;
  if (value.operation === 'GENERATE') {
    if (value.conceptId !== currentCreativeId || parentCreativeId !== null) {
      return null;
    }
  } else if (
    typeof parentCreativeId !== 'string' ||
    !SAFE_CREATIVE_ID.test(parentCreativeId) ||
    parentCreativeId === currentCreativeId ||
    ((value.operation === 'REGENERATE' || value.operation === 'VARIATION') &&
      value.conceptId !== currentCreativeId)
  ) {
    return null;
  }

  return {
    conceptId: value.conceptId,
    parentCreativeId,
    operation: value.operation,
    fingerprint: value.fingerprint,
  };
}

export function validateCreativeIdentityTransition(
  value: unknown,
  currentCreativeId: string,
  parent: CreativeIdentityParent | null
): CreativeIdentity | null {
  const identity = parseCreativeIdentity(value, currentCreativeId);
  if (!identity) return null;

  if (identity.operation === 'GENERATE') {
    return parent === null ? identity : null;
  }
  if (!parent || parent.id !== identity.parentCreativeId) return null;

  const parentIdentity = parseCreativeIdentity(parent.identity, parent.id);
  if (!parentIdentity || identity.conceptId !== (
    identity.operation === 'PLACEMENT' || identity.operation === 'EDIT'
      ? parentIdentity.conceptId
      : currentCreativeId
  )) {
    return null;
  }

  if (
    (identity.operation === 'PLACEMENT' || identity.operation === 'REGENERATE') &&
    identity.fingerprint !== parentIdentity.fingerprint
  ) {
    return null;
  }
  if (
    identity.operation === 'VARIATION' &&
    identity.fingerprint === parentIdentity.fingerprint
  ) {
    return null;
  }

  return identity;
}
