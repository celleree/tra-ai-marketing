import { describe, expect, it } from 'vitest';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import type { CreativeStrategy } from '@/lib/creatives/strategy';

const strategy = (changes: Partial<CreativeStrategy> = {}): CreativeStrategy => ({
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer',
  painPoint: 'Notices', desiredOutcome: 'Resolution', emotion: 'Relief', hook: 'Get organized',
  cta: 'Talk to us', offer: null,
  soWhat: { surfaceMessage: 'Organize your case', functionalConsequence: 'Know the next step', meaningfulOutcome: 'Move forward' },
  execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
  visualDirection: 'Documents on a desk',
  ...changes,
});

const concept = (headline: string, changes: Partial<CreativeStrategy> = {}) => ({ strategy: strategy(changes), copy: { headline } });

const different = () => concept('Get clarity today', {
  category: 'desired-outcomes', awarenessStage: 'solution-aware',
  soWhat: { surfaceMessage: 'Resolve tax questions', functionalConsequence: 'See your options', meaningfulOutcome: 'Feel confident' },
  execution: { subjectSource: 'non-human', composition: 'split', imageTreatment: 'illustrative', textDensity: 'medium', ctaTreatment: 'banner', typographyHierarchy: 'balanced' },
});

describe('getCreativeDiversityIssue', () => {
  it('accepts meaningfully distinct concepts', () => {
    expect(getCreativeDiversityIssue([concept('Organize your case'), different()])).toBeNull();
  });

  it('accepts one strategic and two execution differences', () => {
    const variation = concept('A different headline', {
      awarenessStage: 'solution-aware',
      soWhat: { surfaceMessage: 'A different message', functionalConsequence: 'Know the next step', meaningfulOutcome: 'Move forward' },
      execution: { ...strategy().execution, composition: 'split', textDensity: 'medium' },
    });
    expect(getCreativeDiversityIssue([concept('Organize your case'), variation])).toBeNull();
  });

  it('rejects copy-only changes', () => {
    expect(getCreativeDiversityIssue([concept('Organize your case'), concept('A fresh headline')])).toMatch(/duplicate SO WHAT surface messages/);
  });

  it('rejects a pair with only one execution difference', () => {
    const variation = concept('A fresh headline', {
      awarenessStage: 'solution-aware',
      soWhat: { surfaceMessage: 'A fresh message', functionalConsequence: 'Know the next step', meaningfulOutcome: 'Move forward' },
      execution: { ...strategy().execution, composition: 'split' },
    });
    expect(getCreativeDiversityIssue([concept('Organize your case'), variation])).toMatch(/at least two execution differences/);
  });

  it('does not count source-only changes as diversity', () => {
    const variation = concept('A fresh headline', {
      soWhat: { surfaceMessage: 'A fresh message', functionalConsequence: 'Know the next step', meaningfulOutcome: 'Move forward' },
      execution: { ...strategy().execution, subjectSource: 'approved-tra-human' },
    });
    expect(getCreativeDiversityIssue([concept('Organize your case'), variation])).toMatch(/different category or awareness stage/);
  });

  it('finds non-adjacent duplicate copy after case and whitespace normalization', () => {
    expect(getCreativeDiversityIssue([concept('First message'), different(), concept('  FIRST   MESSAGE ')])).toBe('Variations 1 and 3 have duplicate headlines.');
  });

  it('reports the positions of the first failing pair', () => {
    const second = concept('Second message', {
      soWhat: { surfaceMessage: 'Second message', functionalConsequence: 'Know the next step', meaningfulOutcome: 'Move forward' },
    });
    expect(getCreativeDiversityIssue([concept('First message'), second, different()])).toBe('Variations 1 and 2 need a different category or awareness stage.');
  });
});
