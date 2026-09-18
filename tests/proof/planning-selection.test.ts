import { describe, expect, it } from 'vitest';
import type { PlanningCaseStudyProof, PlanningReviewProof } from '@/lib/proof/planning';
import {
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
  it('hydrates exact contiguous Review excerpts including multiline text', () => {
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
  ])('rejects rewritten or noncontiguous Review text: %j', selectedText => {
    const source = review();
    expect(() => hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText,
      includeAttribution: false,
    }, [source])).toThrow();
  });

  it('rejects model-supplied attribution when no Proof is selected', () => {
    expect(() => hydratePlanningProofSelection(null, [review()], 'Jane D.')).toThrow(
      'requires an attributed Review selection'
    );
  });

  it('rejects Review-style attribution for a Case Study selection', () => {
    const source = caseStudy();
    expect(() => hydratePlanningProofSelection({
      type: 'case-study',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.approvedClaimWording,
    }, [source], 'Jane D.')).toThrow('cannot include Review attribution');
  });

  it('rejects exact canonical attribution when Review attribution was not selected', () => {
    const source = review();
    expect(() => hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: 'Second exact line.',
      includeAttribution: false,
    }, [source], 'Jane D.')).toThrow('not selected for inclusion');
  });

  it('rejects noncanonical attribution when Review attribution was not selected', () => {
    const source = review();
    expect(() => hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: 'Second exact line.',
      includeAttribution: false,
    }, [source], 'Model supplied name')).toThrow('not selected for inclusion');
  });

  it('rejects supplied attribution when the selected Review has no approved attribution', () => {
    const source = review({ attribution: undefined });
    expect(() => hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: 'Second exact line.',
      includeAttribution: true,
    }, [source], 'Jane D.')).toThrow('not approved');
  });

  it('accepts only exact canonical approved Review attribution and hydrates it', () => {
    const source = review();
    const selection = {
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: 'Second exact line.',
      includeAttribution: true,
    };
    expect(hydratePlanningProofSelection(selection, [source], 'Jane D.')).toEqual({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: 'Second exact line.',
      attribution: 'Jane D.',
    });
    expect(() => hydratePlanningProofSelection(selection, [source], 'Jane')).toThrow(
      'canonical approved text'
    );
    expect(() => hydratePlanningProofSelection(selection, [source], ' Jane D. ')).toThrow(
      'canonical approved text'
    );
    expect(() => hydratePlanningProofSelection(selection, [source])).toThrow(
      'canonical approved text'
    );
  });

  it('requires exact Case Study approved wording and hydrates restrictions/disclaimer', () => {
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
        selectedText: 'Second exact line.',
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
