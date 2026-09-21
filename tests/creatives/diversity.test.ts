import { describe, expect, it } from 'vitest';
import { getCreativeDiversityIssue, getCreativeDiversityRepairIndexes, getCreativeDiversityRepairPlan } from '@/lib/creatives/diversity';
import type { CreativeStrategy } from '@/lib/creatives/strategy';
import { portfolioAudit } from '../fixtures/portfolio-audit';
import { parsePortfolioAudit } from '@/lib/creatives/portfolio-audit';

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
  it('accepts distinct audited propositions sharing category, awareness and execution', () => {
    const left = concept('Privacy matters');
    const right = concept('Understand the cost of waiting', { soWhat: { surfaceMessage: 'Consider timing', functionalConsequence: 'Compare options', meaningfulOutcome: 'Make an informed choice' } });
    expect(getCreativeDiversityIssue([left, right], portfolioAudit())).toBeNull();
    const repeated = { ...portfolioAudit(), groups: [{ conceptIndexes: [1, 2], proposition: 'Questions lead to conversation and next steps', distinction: 'These are paraphrases' }] };
    expect(getCreativeDiversityIssue([left, right], repeated)).toContain('repeat a strategic proposition');
    expect(getCreativeDiversityIssue([left, left], portfolioAudit())).toContain('duplicate headlines');
  });

  it('requires a complete, unique global audit partition, including at 36 concepts', () => {
    expect(parsePortfolioAudit(portfolioAudit(36))?.groups).toHaveLength(36);
    expect(parsePortfolioAudit(portfolioAudit(37))).toBeNull();
    const omitted = portfolioAudit(36); omitted.groups.pop();
    expect(parsePortfolioAudit(omitted)).toBeNull();
    const repeated = portfolioAudit(); repeated.groups[1].conceptIndexes = [1];
    expect(parsePortfolioAudit(repeated)).toBeNull();
    expect(getCreativeDiversityIssue([concept('A'), different()], portfolioAudit(3))).toContain('does not cover');
  });
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


describe('getCreativeDiversityRepairIndexes', () => {
  it('keeps the first concept in each semantic duplicate group and replaces only later duplicates', () => {
    const concepts = [concept('One'), different(), concept('Three'), different()];
    const audit = { ...portfolioAudit(4), groups: [
      { conceptIndexes: [1, 3], proposition: 'Same proposition', distinction: 'Paraphrases' },
      { conceptIndexes: [2, 4], proposition: 'Another repeated proposition', distinction: 'Paraphrases' },
    ] };
    expect(getCreativeDiversityRepairIndexes(concepts, audit)).toEqual([3, 4]);
  });

  it('also targets later exact duplicates even when semantic groups are singletons', () => {
    const left = concept('Same headline');
    const right = concept(' same   HEADLINE ');
    expect(getCreativeDiversityRepairIndexes([left, right], portfolioAudit())).toEqual([2]);
  });
  it('builds one repair plan for multiple independent deterministic defects', () => {
    const concepts = [
      concept('Same headline', { soWhat: { surfaceMessage: 'First message', functionalConsequence: 'First consequence', meaningfulOutcome: 'First outcome' } }),
      concept(' same   HEADLINE ', { soWhat: { surfaceMessage: 'Second message', functionalConsequence: 'Second consequence', meaningfulOutcome: 'Second outcome' } }),
      concept('Third headline', { soWhat: { surfaceMessage: 'Same SO WHAT', functionalConsequence: 'Third consequence', meaningfulOutcome: 'Third outcome' } }),
      concept('Fourth headline', { soWhat: { surfaceMessage: ' same   so what ', functionalConsequence: 'Fourth consequence', meaningfulOutcome: 'Fourth outcome' } }),
    ];
    expect(getCreativeDiversityRepairPlan(concepts, portfolioAudit(4))).toEqual({
      replacementIndexes: [2, 4],
      defects: [
        {
          replacementIndex: 2, type: 'DUPLICATE_HEADLINE', relatedIndexes: [1, 2],
          description: 'Variations 1 and 2 have duplicate headlines.',
        },
        {
          replacementIndex: 4, type: 'DUPLICATE_SO_WHAT', relatedIndexes: [3, 4],
          description: 'Variations 3 and 4 have duplicate SO WHAT surface messages.',
        },
      ],
    });
  });

  it('retains every deterministic defect affecting the same replacement target', () => {
    const first = concept('Repeated headline');
    const second = concept(' repeated   HEADLINE ');
    const plan = getCreativeDiversityRepairPlan([first, second], portfolioAudit(2));
    expect(plan.replacementIndexes).toEqual([2]);
    expect(plan.defects.filter(defect => defect.replacementIndex === 2).map(defect => defect.type))
      .toEqual(['DUPLICATE_HEADLINE', 'DUPLICATE_SO_WHAT']);
  });

  it('describes each target in a semantic duplicate group while preserving the earliest anchor', () => {
    const concepts = [
      concept('One', { soWhat: { surfaceMessage: 'Message one', functionalConsequence: 'One', meaningfulOutcome: 'One' } }),
      concept('Two', { soWhat: { surfaceMessage: 'Message two', functionalConsequence: 'Two', meaningfulOutcome: 'Two' } }),
      concept('Three', { soWhat: { surfaceMessage: 'Message three', functionalConsequence: 'Three', meaningfulOutcome: 'Three' } }),
    ];
    const audit = { ...portfolioAudit(3), groups: [
      { conceptIndexes: [1, 2, 3], proposition: 'Same strategic proposition', distinction: 'Paraphrases' },
    ] };
    const plan = getCreativeDiversityRepairPlan(concepts, audit);
    expect(plan.replacementIndexes).toEqual([2, 3]);
    expect(plan.defects).toEqual([
      {
        replacementIndex: 2, type: 'SEMANTIC_DUPLICATE', relatedIndexes: [1, 2, 3],
        description: 'Concepts 1, 2, 3 repeat a strategic proposition: Same strategic proposition',
      },
      {
        replacementIndex: 3, type: 'SEMANTIC_DUPLICATE', relatedIndexes: [1, 2, 3],
        description: 'Concepts 1, 2, 3 repeat a strategic proposition: Same strategic proposition',
      },
    ]);
  });

});
