import { describe, expect, it } from 'vitest';
import { buildCreativeRenderBrief, formatCreativeRenderBrief } from '@/lib/creatives/render-brief';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';

const concept: PlannedCreativeConcept = {
  index: 1, format: 'educational', copy: { headline: 'Talk with TRA', primaryText: 'Explore your options', description: 'A consultation' },
  selectionReason: 'PRIVATE_BATCH_REASON',
  strategy: {
    category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'PRIVATE_PERSONA',
    painPoint: 'PRIVATE_PAIN', desiredOutcome: 'PRIVATE_OUTCOME', emotion: 'PRIVATE_EMOTION',
    hook: 'PRIVATE_HOOK', cta: 'Get a consultation', offer: null,
    soWhat: { surfaceMessage: 'PRIVATE_SURFACE', functionalConsequence: 'PRIVATE_FUNCTION', meaningfulOutcome: 'PRIVATE_MEANING' },
    execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'minimal-graphic',
      textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
    visualDirection: 'One graphic focal point with the headline above it',
  },
};

describe('distilled render brief', () => {
  it('retains execution, exact copy and hard rules while excluding broad planning context', () => {
    const brief = buildCreativeRenderBrief({
      concept, companyProfile: {
        knowledgeBase: { companySummary: 'PRIVATE_SUMMARY', servicesOffers: 'PRIVATE_SERVICES', proof: 'PRIVATE_PROOF' },
        brandGuidelines: { brandColors: '#123456', fonts: 'Approved typeface', voiceTone: 'PRIVATE_VOICE', visualStyle: 'Restrained styling' },
        guardrails: { approvedClaims: 'PRIVATE_CLAIM_CATALOG', neverSay: 'No guaranteed savings', requiredDisclaimers: 'Results vary.' },
      },
    });
    expect(brief.exactCopy).toEqual({ ...concept.copy, cta: concept.strategy.cta });
    expect(brief.brand).toMatchObject({ colors: '#123456', typography: 'Approved typeface', visualStyle: 'Restrained styling' });
    expect(brief.compliance).toMatchObject({ prohibitedClaims: 'No guaranteed savings', requiredDisclaimers: 'Results vary.' });
    expect(brief.execution).toEqual(concept.strategy.execution);
    const prompt = formatCreativeRenderBrief(brief);
    expect(prompt).not.toContain('PRIVATE_');
    expect(prompt).not.toContain('HUMAN PHOTOGRAPHIC REALISM');
    expect(prompt).not.toContain('DOCUMENT-ONLY REFERENCE');
    expect(prompt).not.toContain('HUMAN_PLACEHOLDER');
  });

  it.each(['photographic', 'documentary', 'illustrative', 'minimal-graphic', 'mixed-media'] as const)(
    'adds human realism only for unambiguously photographic human treatment: %s', imageTreatment => {
      const withHuman = { ...concept, strategy: { ...concept.strategy, execution: {
        ...concept.strategy.execution, subjectSource: 'approved-tra-human' as const, imageTreatment,
      } } };
      const prompt = formatCreativeRenderBrief(buildCreativeRenderBrief({ concept: withHuman }));
      expect(prompt.includes('HUMAN PHOTOGRAPHIC REALISM')).toBe(['photographic', 'documentary'].includes(imageTreatment));
    },
  );

  it('uses validated uploaded brand guidance over the profile and retains the seeded document choice', () => {
    const brief = buildCreativeRenderBrief({
      concept: { ...concept, strategy: { ...concept.strategy, execution: { ...concept.strategy.execution, taxDocumentReference: 'irs-notice-v1' } } },
      brandColors: ['#abcdef'], brandFontNames: ['Approved uploaded font'],
    });
    expect(brief.brand.colors).toBe('#abcdef');
    expect(brief.brand.typography).toBe('Approved uploaded font');
    expect(brief.execution.taxDocumentReference).toBe('irs-notice-v1');
    expect(formatCreativeRenderBrief(brief)).not.toContain('DOCUMENT-ONLY REFERENCE');
  });
});
