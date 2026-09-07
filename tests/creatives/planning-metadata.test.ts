import { describe, expect, it } from 'vitest';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';

const strategy = () => ({
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Busy taxpayer',
  painPoint: 'Growing notices', desiredOutcome: 'A clear resolution path', emotion: 'Relief',
  hook: 'Open the letter with confidence', cta: 'Get a consultation', offer: null,
  soWhat: { surfaceMessage: 'We help organize your tax case', functionalConsequence: 'You understand the next step', meaningfulOutcome: 'You can move forward with confidence' },
  execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
  visualDirection: 'A clean desk and organized documents',
});

const planning = () => ({
  strategy: strategy(), selectionReason: ' Distinct strategic fit ', model: ' planner-model ', reasoningEffort: 'medium' as const,
});

describe('CreativePlanningMetadata transport contract', () => {
  it('preserves an exact planning shape with trimmed text', () => {
    expect(parseCreativePlanning(planning())).toMatchObject({
      selectionReason: 'Distinct strategic fit', model: 'planner-model', reasoningEffort: 'medium',
    });
  });

  it.each([
    ['unknown key', () => ({ ...planning(), extra: true })],
    ['missing field', () => { const value = planning(); delete (value as Partial<typeof value>).model; return value; }],
    ['empty selection reason', () => ({ ...planning(), selectionReason: ' ' })],
    ['overlong selection reason', () => ({ ...planning(), selectionReason: 'x'.repeat(1001) })],
    ['overlong model', () => ({ ...planning(), model: 'x'.repeat(201) })],
    ['wrong reasoning effort', () => ({ ...planning(), reasoningEffort: 'high' })],
    ['malformed strategy', () => ({ ...planning(), strategy: { ...strategy(), unexpected: true } })],
  ])('rejects %s', (_name, makeValue) => {
    expect(parseCreativePlanning(makeValue())).toBeNull();
  });

  it('accepts a human strategy as shape-only planning metadata', () => {
    const human = { ...strategy(), execution: { ...strategy().execution, subjectSource: 'approved-tra-human' } };
    expect(parseCreativePlanning({ ...planning(), strategy: human })?.strategy.execution.subjectSource)
      .toBe('approved-tra-human');
  });
});
