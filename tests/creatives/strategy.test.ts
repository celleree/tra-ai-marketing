import { describe, expect, it } from 'vitest';
import { parseCreativeStrategy } from '@/lib/creatives/strategy';

const strategy = () => ({
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: ' Busy taxpayer ',
  painPoint: 'Growing notices', desiredOutcome: 'A clear resolution path', emotion: 'Relief',
  hook: 'Open the letter with confidence', cta: 'Get a consultation', offer: null,
  soWhat: { surfaceMessage: 'We help organize your tax case', functionalConsequence: 'You understand the next step', meaningfulOutcome: 'You can move forward with confidence' },
  execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
  visualDirection: 'A clean desk and organized documents',
});

describe('CreativeStrategy contract', () => {
  it('preserves the complete trimmed SO WHAT chain', () => {
    const parsed = parseCreativeStrategy(strategy(), false);
    expect(parsed).toMatchObject({ persona: 'Busy taxpayer', soWhat: strategy().soWhat });
  });

  it.each([
    ['missing outcome chain', () => { const value = strategy(); delete (value.soWhat as Partial<typeof value.soWhat>).meaningfulOutcome; return value; }],
    ['malformed enum', () => ({ ...strategy(), execution: { ...strategy().execution, composition: 'collage' } })],
    ['empty top-level text', () => ({ ...strategy(), persona: '   ' })],
    ['type-invalid top-level text', () => ({ ...strategy(), painPoint: 3 })],
    ['missing top-level text', () => { const value = strategy(); delete (value as Partial<typeof value>).cta; return value; }],
    ['overlong text', () => ({ ...strategy(), hook: 'x'.repeat(1001) })],
    ['unknown key', () => ({ ...strategy(), unexpected: true })],
  ])('rejects %s', (_name, makeValue) => expect(parseCreativeStrategy(makeValue(), false)).toBeNull());

  it('requires a supplied approved source for a human strategy', () => {
    const human = { ...strategy(), execution: { ...strategy().execution, subjectSource: 'approved-tra-human' } };
    expect(parseCreativeStrategy(human, false)).toBeNull();
    expect(parseCreativeStrategy(human, true)?.execution.subjectSource).toBe('approved-tra-human');
  });

  it('accepts non-human strategies with or without an approved source', () => {
    expect(parseCreativeStrategy(strategy(), false)).not.toBeNull();
    expect(parseCreativeStrategy(strategy(), true)).not.toBeNull();
  });
});
