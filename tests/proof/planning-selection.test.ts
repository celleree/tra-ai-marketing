import { describe, expect, it } from 'vitest';
import type { PlanningCaseStudyProof, PlanningReviewProof } from '@/lib/proof/planning';
import {
  composePlanningCopyWithProof,
  hydratePlanningProofSelection,
  isSelectedPlanningProof,
} from '@/lib/proof/planning-selection';

const review = (overrides: Partial<PlanningReviewProof> = {}): PlanningReviewProof => ({
  id: `proof_${'a'.repeat(32)}`,
  type: 'review',
  updatedAt: '2026-09-18T12:00:00.000Z',
  tags: ['service'],
  originalReviewText: 'First exact line.\nSecond exact line.\nThird exact line.',
  attribution: { display: 'Jane D.', allowed: true },
  ...overrides,
});

const caseStudy = (
  overrides: Partial<PlanningCaseStudyProof> = {}
): PlanningCaseStudyProof => ({
  id: `proof_${'b'.repeat(32)}`,
  type: 'case-study',
  updatedAt: '2026-09-18T13:00:00.000Z',
  tags: ['bank levy'],
  title: 'Bank levy case',
  approvedClaimWording: 'Approved source-bound claim wording.',
  usageRestrictions: 'Use only for bank-levy messaging.',
  requiredDisclaimer: 'Results vary by circumstances.',
  ...overrides,
});

describe('planning proof selection', () => {
  it('hydrates exact Review text on whole review-line boundaries', () => {
    const source = review();
    const selectedText = 'First exact line.\nSecond exact line.';
    expect(hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText,
      includeAttribution: false,
    }, [source])).toEqual({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText,
    });
  });

  it.each([
    'First exact line. Second exact line.',
    'First exact line.\nThird exact line.',
    'First exact line.\nSecond rewritten line.',
  ])('rejects clipped, rewritten, or noncontiguous Review text: %j', selectedText => {
    const source = review();
    expect(() => hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText,
      includeAttribution: false,
    }, [source])).toThrow();
  });

  it('hydrates approved Review attribution from the record instead of model copy', () => {
    const source = review();
    expect(hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.originalReviewText,
      includeAttribution: true,
    }, [source])).toEqual({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.originalReviewText,
      attribution: 'Jane D.',
    });

    const noAttribution = review({ attribution: undefined });
    expect(() => hydratePlanningProofSelection({
      type: 'review',
      proofId: noAttribution.id,
      proofUpdatedAt: noAttribution.updatedAt,
      selectedText: noAttribution.originalReviewText,
      includeAttribution: true,
    }, [noAttribution])).toThrow('not approved');
  });

  it('requires exact Case Study wording and hydrates restrictions/disclaimer', () => {
    const source = caseStudy();
    expect(hydratePlanningProofSelection({
      type: 'case-study',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.approvedClaimWording,
    }, [source])).toEqual({
      type: 'case-study',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.approvedClaimWording,
      usageRestrictions: source.usageRestrictions,
      requiredDisclaimer: source.requiredDisclaimer,
    });
    expect(() => hydratePlanningProofSelection({
      type: 'case-study',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: 'Broader rewritten claim.',
    }, [source])).toThrow('exact approved wording');
  });

  it.each(['unknown', 'wrong-type', 'stale'] as const)(
    'rejects %s selections',
    problem => {
      const source = review();
      const selection = {
        type: 'review',
        proofId: source.id,
        proofUpdatedAt: source.updatedAt,
        selectedText: source.originalReviewText,
        includeAttribution: false,
      };
      if (problem === 'unknown') selection.proofId = `proof_${'f'.repeat(32)}`;
      if (problem === 'stale') selection.proofUpdatedAt = '2026-09-17T12:00:00.000Z';
      const catalog = problem === 'wrong-type'
        ? [caseStudy({ id: source.id, updatedAt: source.updatedAt })]
        : [source];
      expect(() => hydratePlanningProofSelection(selection, catalog)).toThrow(
        'unknown, stale, or wrong-type'
      );
    }
  );

  it('appends exact Review Proof after normal primary text and owns attribution', () => {
    const source = review();
    const selected = hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.originalReviewText,
      includeAttribution: true,
    }, [source]);

    expect(composePlanningCopyWithProof(
      selected,
      { primaryText: 'Normal AI-written copy.', headline: 'Headline', description: '' },
      {
        headline: 'Image headline',
        shortSupport: 'Support',
        proofAttribution: 'MODEL SHOULD NOT CONTROL THIS',
        disclosure: 'General disclosure',
      }
    )).toEqual({
      adCopy: {
        primaryText: `Normal AI-written copy.\n\n${source.originalReviewText}\n\nJane D.`,
        headline: 'Headline',
        description: '',
      },
      imageCopy: {
        headline: 'Image headline',
        shortSupport: 'Support',
        proofAttribution: 'Jane D.',
        disclosure: 'General disclosure',
      },
    });
  });

  it('appends exact Case Study Proof and required disclaimer deterministically', () => {
    const source = caseStudy();
    const selected = hydratePlanningProofSelection({
      type: 'case-study',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.approvedClaimWording,
    }, [source]);

    expect(composePlanningCopyWithProof(
      selected,
      { primaryText: 'Normal AI-written copy.', headline: 'Headline', description: '' },
      {
        headline: 'Image headline',
        proofAttribution: 'MODEL ATTRIBUTION',
        disclosure: 'MODEL DISCLOSURE',
      }
    )).toEqual({
      adCopy: {
        primaryText: `Normal AI-written copy.\n\n${source.approvedClaimWording}\n\n${source.requiredDisclaimer}`,
        headline: 'Headline',
        description: '',
      },
      imageCopy: {
        headline: 'Image headline',
        disclosure: source.requiredDisclaimer,
      },
    });
  });

  it('leaves normal copy alone when no Proof is selected and strips proof attribution', () => {
    expect(composePlanningCopyWithProof(
      null,
      { primaryText: 'Normal copy.', headline: 'Headline', description: '' },
      {
        headline: 'Image headline',
        proofAttribution: 'UNBOUND ATTRIBUTION',
        disclosure: 'General disclosure',
      }
    )).toEqual({
      adCopy: { primaryText: 'Normal copy.', headline: 'Headline', description: '' },
      imageCopy: { headline: 'Image headline', disclosure: 'General disclosure' },
    });
  });

  it('accepts null and persisted shapes without exposing source-only Case Study facts', () => {
    expect(hydratePlanningProofSelection(null, [review(), caseStudy()])).toBeNull();
    const hydrated = hydratePlanningProofSelection({
      type: 'case-study',
      proofId: caseStudy().id,
      proofUpdatedAt: caseStudy().updatedAt,
      selectedText: caseStudy().approvedClaimWording,
    }, [caseStudy()]);
    expect(isSelectedPlanningProof(hydrated)).toBe(true);
    expect(JSON.stringify(hydrated)).not.toContain('verifiedFacts');
  });
});
