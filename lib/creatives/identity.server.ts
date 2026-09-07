import { createHash } from 'node:crypto';
import {
  parseCreativeIdentity,
  validateCreativeIdentityTransition,
  type CreativeIdentity,
  type CreativeIdentityParent,
} from '@/lib/creatives/identity';
import { parseCreativeStrategy } from '@/lib/creatives/strategy';

type BuildCreativeIdentityInput =
  | { creativeId: string; operation: 'GENERATE'; strategy: unknown }
  | {
      creativeId: string;
      operation: 'PLACEMENT' | 'REGENERATE';
      parent: CreativeIdentityParent;
    }
  | {
      creativeId: string;
      operation: 'EDIT';
      parent: CreativeIdentityParent;
      strategy?: unknown;
    }
  | {
      creativeId: string;
      operation: 'VARIATION';
      parent: CreativeIdentityParent;
      strategy: unknown;
    };

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)])
  );
};

export function fingerprintCreativeStrategy(value: unknown): string {
  const strategy = parseCreativeStrategy(value, true);
  if (!strategy) throw new Error('Creative strategy is invalid.');
  const canonicalJson = JSON.stringify(sortJson(strategy));
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

const requireParentIdentity = (parent: CreativeIdentityParent) => {
  const identity = parseCreativeIdentity(parent.identity, parent.id);
  if (!identity) throw new Error('Parent creative identity is missing or invalid.');
  return { id: parent.id, identity };
};

const requireTransition = (
  identity: CreativeIdentity,
  creativeId: string,
  parent: CreativeIdentityParent | null
) => {
  const parsed = validateCreativeIdentityTransition(identity, creativeId, parent);
  if (!parsed) throw new Error('Creative identity transition is invalid.');
  return parsed;
};

export function buildCreativeIdentity(
  input: BuildCreativeIdentityInput
): CreativeIdentity {
  if (input.operation === 'GENERATE') {
    return requireTransition(
      {
        conceptId: input.creativeId,
        parentCreativeId: null,
        operation: input.operation,
        fingerprint: fingerprintCreativeStrategy(input.strategy),
      },
      input.creativeId,
      null
    );
  }

  const parent = requireParentIdentity(input.parent);
  const newConcept =
    input.operation === 'REGENERATE' || input.operation === 'VARIATION';
  const fingerprint =
    input.operation === 'VARIATION' ||
    (input.operation === 'EDIT' && input.strategy !== undefined)
      ? fingerprintCreativeStrategy(input.strategy)
      : parent.identity.fingerprint;

  return requireTransition(
    {
      conceptId: newConcept ? input.creativeId : parent.identity.conceptId,
      parentCreativeId: parent.id,
      operation: input.operation,
      fingerprint,
    },
    input.creativeId,
    parent
  );
}
