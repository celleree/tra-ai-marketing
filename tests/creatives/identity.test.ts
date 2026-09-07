import { describe, expect, it } from 'vitest';
import {
  parseCreativeIdentity,
  validateCreativeIdentityTransition,
  type CreativeIdentity,
} from '@/lib/creatives/identity';
import {
  buildCreativeIdentity,
  fingerprintCreativeStrategy,
} from '@/lib/creatives/identity.server';

const ID = {
  root: `creative_${'a'.repeat(32)}`,
  child: `creative_${'b'.repeat(32)}`,
  next: `creative_${'c'.repeat(32)}`,
};

const strategy = () => ({
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: ' Busy taxpayer ',
  painPoint: 'Growing notices', desiredOutcome: 'A clear resolution path', emotion: 'Relief',
  hook: 'Open the letter with confidence', cta: 'Get a consultation', offer: null,
  soWhat: { surfaceMessage: 'We help organize your tax case', functionalConsequence: 'You understand the next step', meaningfulOutcome: 'You can move forward with confidence' },
  execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
  visualDirection: 'A clean desk and organized documents',
});

const generated = () => buildCreativeIdentity({
  creativeId: ID.root,
  operation: 'GENERATE',
  strategy: strategy(),
});

describe('creative identity parsing', () => {
  it('accepts an exact generated root identity', () => {
    expect(parseCreativeIdentity(generated(), ID.root)).toEqual(generated());
  });

  it.each([
    ['unknown field', { extra: true }],
    ['unsafe concept ID', { conceptId: 'creative_bad' }],
    ['unsafe parent ID', { operation: 'EDIT', parentCreativeId: 'creative_bad' }],
    ['unknown operation', { operation: 'UPLOAD' }],
    ['invalid fingerprint', { fingerprint: 'A'.repeat(64) }],
    ['root with a parent', { parentCreativeId: ID.child }],
    ['root with another concept', { conceptId: ID.child }],
  ])('rejects %s', (_label, change) => {
    expect(parseCreativeIdentity({ ...generated(), ...change }, ID.root)).toBeNull();
  });

  it('rejects self-parenting and requires new concepts for regeneration and variation', () => {
    const parent = { id: ID.root, identity: generated() };
    const regenerated = buildCreativeIdentity({ creativeId: ID.child, operation: 'REGENERATE', parent });
    expect(parseCreativeIdentity({ ...regenerated, parentCreativeId: ID.child }, ID.child)).toBeNull();
    expect(parseCreativeIdentity({ ...regenerated, conceptId: ID.root }, ID.child)).toBeNull();
    expect(parseCreativeIdentity({ ...regenerated, operation: 'VARIATION', conceptId: ID.root }, ID.child)).toBeNull();
  });
});

describe('strategy fingerprints', () => {
  it('uses a stable canonical SHA-256 of the trimmed validated strategy', () => {
    expect(fingerprintCreativeStrategy(strategy())).toBe(
      'b0abfb83ace3d2db1c3c47e49141d29350ba5784053ba66eaf5ed3c84a21da2d'
    );

    const source = strategy();
    const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(source).reverse());
    reordered.soWhat = Object.fromEntries(Object.entries(source.soWhat).reverse());
    reordered.execution = Object.fromEntries(Object.entries(source.execution).reverse());
    expect(fingerprintCreativeStrategy(reordered)).toBe(fingerprintCreativeStrategy(strategy()));
  });

  it('changes when normalized strategy changes and rejects malformed strategies', () => {
    expect(fingerprintCreativeStrategy({ ...strategy(), emotion: 'Confidence' }))
      .not.toBe(fingerprintCreativeStrategy(strategy()));
    expect(() => fingerprintCreativeStrategy({ ...strategy(), unexpected: true })).toThrow('invalid');
  });
});

describe('creative identity transitions and builders', () => {
  it('derives every operation without caller-provided identity values', () => {
    const root = generated();
    const parent = { id: ID.root, identity: root };
    const placement = buildCreativeIdentity({ creativeId: ID.child, operation: 'PLACEMENT', parent });
    const unchangedEdit = buildCreativeIdentity({ creativeId: ID.child, operation: 'EDIT', parent });
    const changedEdit = buildCreativeIdentity({ creativeId: ID.child, operation: 'EDIT', parent, strategy: { ...strategy(), emotion: 'Confidence' } });
    const regeneration = buildCreativeIdentity({ creativeId: ID.child, operation: 'REGENERATE', parent });
    const variation = buildCreativeIdentity({ creativeId: ID.child, operation: 'VARIATION', parent, strategy: { ...strategy(), awarenessStage: 'solution-aware' } });

    expect(placement).toMatchObject({ conceptId: ID.root, parentCreativeId: ID.root, fingerprint: root.fingerprint });
    expect(unchangedEdit.fingerprint).toBe(root.fingerprint);
    expect(changedEdit).toMatchObject({ conceptId: ID.root, operation: 'EDIT' });
    expect(changedEdit.fingerprint).not.toBe(root.fingerprint);
    expect(regeneration).toMatchObject({ conceptId: ID.child, fingerprint: root.fingerprint });
    expect(variation).toMatchObject({ conceptId: ID.child, operation: 'VARIATION' });
    expect(variation.fingerprint).not.toBe(root.fingerprint);
    expect(() => buildCreativeIdentity({ creativeId: ID.next, operation: 'EDIT', parent, strategy: null })).toThrow('strategy');
  });

  it('rejects missing parents, wrong families, and invalid inherited fingerprints', () => {
    const root = generated();
    const parent = { id: ID.root, identity: root };
    const placement = buildCreativeIdentity({ creativeId: ID.child, operation: 'PLACEMENT', parent });
    const badFamily: CreativeIdentity = { ...placement, conceptId: ID.next };
    const badFingerprint: CreativeIdentity = { ...placement, fingerprint: 'f'.repeat(64) };

    expect(validateCreativeIdentityTransition(placement, ID.child, null)).toBeNull();
    expect(validateCreativeIdentityTransition(root, ID.root, parent)).toBeNull();
    expect(validateCreativeIdentityTransition(placement, ID.child, { ...parent, id: ID.next })).toBeNull();
    expect(validateCreativeIdentityTransition(badFamily, ID.child, parent)).toBeNull();
    expect(validateCreativeIdentityTransition(badFingerprint, ID.child, parent)).toBeNull();
    expect(() => buildCreativeIdentity({ creativeId: ID.child, operation: 'PLACEMENT', parent: { id: ID.root } })).toThrow('Parent');
  });

  it('requires regeneration to retain and variation to change the parent fingerprint', () => {
    const root = generated();
    const parent = { id: ID.root, identity: root };
    const regeneration = buildCreativeIdentity({ creativeId: ID.child, operation: 'REGENERATE', parent });
    const sameVariation = { ...regeneration, operation: 'VARIATION' as const };
    const changedRegeneration = { ...regeneration, fingerprint: 'f'.repeat(64) };

    expect(validateCreativeIdentityTransition(sameVariation, ID.child, parent)).toBeNull();
    expect(validateCreativeIdentityTransition(changedRegeneration, ID.child, parent)).toBeNull();
    expect(() => buildCreativeIdentity({ creativeId: ID.child, operation: 'VARIATION', parent, strategy: strategy() })).toThrow('transition');
  });
});
