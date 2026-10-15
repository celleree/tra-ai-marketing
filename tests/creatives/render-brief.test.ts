import { describe, expect, it } from 'vitest';
import { buildCreativeRenderBrief, formatCreativeRenderBrief } from '@/lib/creatives/render-brief';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { resolveReferenceSelection } from '@/lib/references/planning';

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
  it('uses only the selected layout and honors original over an uploaded legacy blueprint', () => {
    const referenceCatalog = [referenceCandidate('a'), referenceCandidate('b')];
    referenceCatalog[1].blueprint.ctaTreatment = 'OUTLINE';
    const [a, b] = referenceCatalog.map(item => item.referenceId);
    for (const layoutSource of [b, null]) {
      const referenceSelection = resolveReferenceSelection({ angleSource: a, layoutSource }, referenceCatalog);
      const brief = buildCreativeRenderBrief({ concept: { ...concept, strategy: { ...concept.strategy, referenceSelection } },
        referenceCatalog, layoutBlueprint: referenceCatalog[0].blueprint });
      expect(brief.layoutBlueprint).toEqual(layoutSource ? referenceCatalog[1].blueprint : undefined);
      const prompt = formatCreativeRenderBrief(brief);
      expect(prompt).not.toContain(a);
      expect(prompt).not.toContain(referenceCatalog[0].angleDescription);
    }
  });

  it('makes selected blueprint geometry authoritative without importing restricted reference content', () => {
    const selected = referenceCandidate('b');
    selected.blueprint = {
      ...selected.blueprint,
      composition: { flow: 'TEXT_LEFT_VISUAL_RIGHT', balance: 'ASYMMETRIC', imageTextBalance: 'BALANCED' },
      regions: [
        { role: 'HEADLINE', xPct: 8, yPct: 10, widthPct: 46, heightPct: 20, alignment: 'LEFT', emphasis: 'PRIMARY', crop: 'NONE', overlapsOtherRegions: false },
        { role: 'HUMAN_PLACEHOLDER', xPct: 58, yPct: 8, widthPct: 34, heightPct: 72, alignment: 'CENTER', emphasis: 'HIGH', crop: 'WAIST_UP', overlapsOtherRegions: false },
        { role: 'CTA', xPct: 8, yPct: 76, widthPct: 30, heightPct: 10, alignment: 'LEFT', emphasis: 'MEDIUM', crop: 'NONE', overlapsOtherRegions: false },
      ],
      whitespace: 'MODERATE', textDensity: 'SPARSE', ctaTreatment: 'PILL',
      typography: { headlineScale: 'EXTRA_LARGE', headlineWeight: 'EXTRABOLD', headlineAlignment: 'LEFT', hierarchyLevels: 3, contrast: 'HIGH' },
      spacing: { outerMargin: 'GENEROUS', regionGap: 'MODERATE', alignmentGrid: 'LEFT_EDGE' },
      restrictedElementsPresent: { humanIdentity: true, thirdPartyLogoOrBranding: true, exactCopy: true, trademark: true, claimOrProof: true },
    };
    const referenceCatalog = [selected];
    const referenceSelection = resolveReferenceSelection({ angleSource: null, layoutSource: selected.referenceId }, referenceCatalog);
    const prompt = formatCreativeRenderBrief(buildCreativeRenderBrief({
      concept: { ...concept, imageCopy: { headline: 'Image headline' }, strategy: { ...concept.strategy,
        execution: { ...concept.strategy.execution, composition: 'stacked' },
        visualDirection: 'Ignore the split and center everything', referenceSelection } }, referenceCatalog,
    }));

    expect(prompt).toContain('AUTHORITATIVE COMPOSITION SCAFFOLD');
    expect(prompt).toContain('Preserve all 3 meaningful blueprint regions proportionally');
    expect(prompt).toContain('1. HEADLINE: x=8%, y=10%, width=46%, height=20%, alignment=LEFT, emphasis=PRIMARY');
    expect(prompt).toContain('2. HUMAN_PLACEHOLDER: x=58%, y=8%, width=34%, height=72%');
    expect(prompt).toContain('whitespace=MODERATE, text density=SPARSE');
    expect(prompt).toContain('must not replace, reorder or materially resize blueprint structure when they conflict');
    expect(prompt).toContain('never treat safe zones as decorative borders');
    expect(prompt).toContain('Planned image text fields: headline');
    expect(prompt).toContain('Absent optional imageCopy fields (shortSupport, proofAttribution, cta, disclosure) must stay absent');
    expect(prompt).toContain('No CTA text is planned; do not create a CTA label, button or treatment');
    expect(prompt).toContain('HUMAN_PLACEHOLDER controls geometry only and never authorizes a person, face or identity');
    expect(prompt).toContain('restrictedElementsPresent is warning metadata');
    expect(prompt).toContain('Never reproduce external people/identity, branding/logos, exact copy, claims, testimonials/proof or trademarks');
    expect(prompt).toContain('raw Layout Reference pixels must not be introduced into final image generation');
    expect(prompt).not.toContain(concept.copy.primaryText);
    expect(prompt).not.toContain(concept.copy.description);
  });

  it('includes authoritative Review Proof only as evidence context, not extra image copy', () => {
    const proofProvenance = {
      version: 1 as const, type: 'review' as const, proofId: `proof_${'a'.repeat(32)}`,
      proofUpdatedAt: '2026-09-18T13:00:00.000Z', selectedText: 'Exact client review excerpt.',
      attribution: 'Verified TRA client',
    };
    const brief = buildCreativeRenderBrief({
      concept: { ...concept, imageCopy: { headline: 'Image headline', proofAttribution: 'Verified TRA client' } },
      proofProvenance,
    });
    const prompt = formatCreativeRenderBrief(brief);
    expect(brief.proof).toEqual(proofProvenance);
    expect(prompt).toContain(proofProvenance.proofId);
    expect(prompt).toContain(proofProvenance.proofUpdatedAt);
    expect(prompt).toContain(proofProvenance.selectedText);
    expect(prompt).toContain(proofProvenance.attribution);
    expect(prompt).toContain('It is NOT additional image copy');
    expect(brief.exactCopy).toEqual({ headline: 'Image headline', proofAttribution: 'Verified TRA client' });
  });

  it('includes Case Study restrictions/disclaimer and invents no Proof block when none is selected', () => {
    const proofProvenance = {
      version: 1 as const, type: 'case-study' as const, proofId: `proof_${'b'.repeat(32)}`,
      proofUpdatedAt: '2026-09-18T14:00:00.000Z', selectedText: 'Approved source-bound claim wording.',
      usageRestrictions: 'Use only for bank-levy messaging.',
      requiredDisclaimer: 'Results vary by circumstances.',
    };
    const withProof = buildCreativeRenderBrief({
      concept: { ...concept, imageCopy: { headline: 'Approved source-bound claim wording.', disclosure: 'Results vary by circumstances.' } },
      proofProvenance,
    });
    const prompt = formatCreativeRenderBrief(withProof);
    expect(prompt).toContain(proofProvenance.usageRestrictions);
    expect(prompt).toContain(proofProvenance.requiredDisclaimer);
    expect(prompt).toContain('"disclosure": "Results vary by circumstances."');

    const withoutProof = buildCreativeRenderBrief({ concept: { ...concept, imageCopy: { headline: 'Image headline' } } });
    expect(withoutProof).not.toHaveProperty('proof');
    expect(formatCreativeRenderBrief(withoutProof)).toContain('No Proof is selected.');
    expect(formatCreativeRenderBrief(withoutProof)).not.toContain(proofProvenance.proofId);
  });

  it('passes visual concept details but excludes strategic fields and preserves exact copy', () => {
    const details = { ...conceptDetails, angle: 'PRIVATE_ANGLE', proposition: 'PRIVATE_PROPOSITION',
      objection: 'PRIVATE_OBJECTION', mainMessage: 'PRIVATE_MESSAGE' };
    const brief = buildCreativeRenderBrief({ concept: { ...concept, strategy: { ...concept.strategy, conceptDetails: details } } });
    expect(brief.visualConcept).toEqual({ visualArchetype: details.visualArchetype, visualMechanism: details.visualMechanism,
      subject: details.subject, environment: details.environment, compositionInstructions: details.compositionInstructions });
    expect(brief.exactCopy).toEqual({ ...concept.copy, cta: concept.strategy.cta });
    expect(formatCreativeRenderBrief(brief)).not.toContain('PRIVATE_');
    expect(buildCreativeRenderBrief({ concept })).not.toHaveProperty('visualConcept');
  });

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
