import { describe, expect, it } from 'vitest';
import type { PlanningCaseStudyProof, PlanningReviewProof } from '@/lib/proof/planning';
import {
  hydratePlanningProofSelection,
  isSelectedPlanningProof,
  validatePlanningProofCopyConsistency,
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

  it('rejects Proof-derived ad-facing copy when no matching selection exists', () => {
    const reviewSource = review();
    const caseSource = caseStudy();
    const base = {
      adCopy: { primaryText: 'Ordinary copy', headline: 'Ordinary headline', description: '' },
      imageCopy: { headline: 'Ordinary image headline' },
    };
    expect(() => validatePlanningProofCopyConsistency(null, [reviewSource], {
      ...base,
      adCopy: { ...base.adCopy, primaryText: 'Second exact line.' },
    })).toThrow('Review text is not bound');
    expect(() => validatePlanningProofCopyConsistency(null, [caseSource], {
      ...base,
      imageCopy: { headline: caseSource.approvedClaimWording },
    })).toThrow('Case Study text is not bound');
  });

  it('rejects material shortened Proof fragments and unselected Case Study disclaimers', () => {
    const negative = review({ originalReviewText: 'I did not save $10,000.' });
    const contextual = review({
      id: `proof_${'d'.repeat(32)}`,
      originalReviewText: 'The representative was patient and explained every step clearly.',
    });
    const caseSource = caseStudy({
      approvedClaimWording: 'TRA helped the client understand the next steps clearly.',
      requiredDisclaimer: 'Results vary based on each client circumstances.',
    });
    const base = {
      adCopy: { primaryText: 'Ordinary copy', headline: 'Ordinary headline', description: '' },
      imageCopy: { headline: 'Ordinary image headline' },
    };

    expect(() => validatePlanningProofCopyConsistency(null, [negative], {
      ...base,
      adCopy: { ...base.adCopy, primaryText: 'save $10,000' },
    })).toThrow('Material ad-facing Review text');

    expect(() => validatePlanningProofCopyConsistency(null, [contextual], {
      ...base,
      imageCopy: { ...base.imageCopy, shortSupport: 'explained every step clearly' },
    })).toThrow('Material ad-facing Review text');

    expect(() => validatePlanningProofCopyConsistency(null, [caseSource], {
      ...base,
      adCopy: { ...base.adCopy, headline: 'understand the next steps clearly' },
    })).toThrow('Material ad-facing Case Study text');

    expect(() => validatePlanningProofCopyConsistency(null, [caseSource], {
      ...base,
      imageCopy: { ...base.imageCopy, disclosure: caseSource.requiredDisclaimer },
    })).toThrow('Case Study text is not bound');
  });

  it.each(['debt forgiven', 'levy released', 'tax resolved', 'penalties removed'])(
    'rejects short non-numeric material Case Study fragments without Proof selection: %s',
    fragment => {
      const source = caseStudy({
        approvedClaimWording: `Client ${fragment} after review.`,
        requiredDisclaimer: undefined,
      });
      const copy = {
        adCopy: { primaryText: fragment, headline: 'Headline', description: '' },
        imageCopy: { headline: 'Image headline' },
      };

      expect(() => validatePlanningProofCopyConsistency(null, [source], copy))
        .toThrow('Material ad-facing Case Study text');
    }
  );

  it('does not treat generic short Case Study overlap as material Proof use', () => {
    const source = caseStudy({
      approvedClaimWording: 'TRA helped the client understand the next steps clearly.',
      requiredDisclaimer: undefined,
    });
    const copy = {
      adCopy: { primaryText: 'Understand the next steps', headline: 'Headline', description: '' },
      imageCopy: { headline: 'Image headline' },
    };

    expect(() => validatePlanningProofCopyConsistency(null, [source], copy)).not.toThrow();
  });

  it('rejects short material Review outcome fragments without Proof selection', () => {
    const source = review({ originalReviewText: 'My tax issue was resolved quickly.' });
    const copy = {
      adCopy: { primaryText: 'Tax issue resolved', headline: 'Headline', description: '' },
      imageCopy: { headline: 'Image headline' },
    };

    expect(() => validatePlanningProofCopyConsistency(null, [source], copy))
      .toThrow('Material ad-facing Review text');
  });

  it('rejects extra Proof-derived wording even when the valid selected Review text is present', () => {
    const source = review({ originalReviewText: 'I did not save $10,000.' });
    const selected = hydratePlanningProofSelection({
      type: 'review',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.originalReviewText,
      includeAttribution: false,
    }, [source]);
    const base = {
      adCopy: { primaryText: source.originalReviewText, headline: 'Headline', description: '' },
      imageCopy: { headline: 'Image headline' },
    };

    expect(() => validatePlanningProofCopyConsistency(selected, [source], base)).not.toThrow();
    expect(() => validatePlanningProofCopyConsistency(selected, [source], {
      ...base,
      adCopy: {
        ...base.adCopy,
        primaryText: `${source.originalReviewText} I saved $10,000.`,
      },
    })).toThrow('additional Proof-derived wording');
  });

  it('rejects extra Case Study-derived wording even when the exact approved claim is present', () => {
    const source = caseStudy({
      approvedClaimWording: 'TRA helped the client understand the next steps clearly.',
      requiredDisclaimer: 'Results vary by circumstances.',
    });
    const selected = hydratePlanningProofSelection({
      type: 'case-study',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.approvedClaimWording,
    }, [source]);
    const base = {
      adCopy: { primaryText: source.approvedClaimWording, headline: 'Headline', description: '' },
      imageCopy: { headline: 'Image headline', disclosure: source.requiredDisclaimer },
    };

    expect(() => validatePlanningProofCopyConsistency(selected, [source], base)).not.toThrow();
    expect(() => validatePlanningProofCopyConsistency(selected, [source], {
      ...base,
      adCopy: {
        ...base.adCopy,
        primaryText: `${source.approvedClaimWording} understand the next steps clearly`,
      },
    })).toThrow('additional Proof-derived wording');
  });

  it.each(['save 10,000', 'save $10000'])(
    'normalizes equivalent currency formatting before Proof matching: %s',
    fragment => {
      const source = review({ originalReviewText: 'I did not save $10,000.' });
      const base = {
        adCopy: { primaryText: fragment, headline: 'Headline', description: '' },
        imageCopy: { headline: 'Image headline' },
      };
      expect(() => validatePlanningProofCopyConsistency(null, [source], base))
        .toThrow('Review text is not bound');
    }
  );

  it('does not let overlapping generic Review wording steal a valid selected Proof', () => {
    const selectedSource = review({
      originalReviewText: 'They were very helpful and professional.',
    });
    const overlapping = review({
      id: `proof_${'c'.repeat(32)}`,
      originalReviewText: 'The team was very helpful and responsive.',
    });
    const selected = hydratePlanningProofSelection({
      type: 'review',
      proofId: selectedSource.id,
      proofUpdatedAt: selectedSource.updatedAt,
      selectedText: selectedSource.originalReviewText,
      includeAttribution: false,
    }, [selectedSource, overlapping]);

    expect(() => validatePlanningProofCopyConsistency(selected, [selectedSource, overlapping], {
      adCopy: { primaryText: selectedSource.originalReviewText, headline: 'Headline', description: '' },
      imageCopy: { headline: 'Image headline' },
    })).not.toThrow();
  });

  it('requires selected Proof text to be used exactly and rejects wording from another Proof', () => {
    const selectedSource = review();
    const otherSource = review({
      id: `proof_${'c'.repeat(32)}`,
      originalReviewText: 'Different approved sentence.',
    });
    const selected = hydratePlanningProofSelection({
      type: 'review',
      proofId: selectedSource.id,
      proofUpdatedAt: selectedSource.updatedAt,
      selectedText: 'Second exact line.',
      includeAttribution: false,
    }, [selectedSource, otherSource]);
    const base = {
      adCopy: { primaryText: 'Second exact line.', headline: 'Ordinary headline', description: '' },
      imageCopy: { headline: 'Ordinary image headline' },
    };
    expect(() => validatePlanningProofCopyConsistency(selected, [selectedSource, otherSource], base))
      .not.toThrow();
    expect(() => validatePlanningProofCopyConsistency(selected, [selectedSource, otherSource], {
      ...base,
      imageCopy: { headline: 'Different approved sentence.' },
    })).toThrow('Review text is not bound');
    expect(() => validatePlanningProofCopyConsistency(selected, [selectedSource], {
      ...base,
      adCopy: { ...base.adCopy, primaryText: 'Ordinary copy' },
    })).toThrow('Selected Proof text is not present');
  });

  it('requires the canonical Case Study disclosure when the selected record requires one', () => {
    const source = caseStudy();
    const selected = hydratePlanningProofSelection({
      type: 'case-study',
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.approvedClaimWording,
    }, [source]);
    const valid = {
      adCopy: { primaryText: source.approvedClaimWording, headline: 'Headline', description: '' },
      imageCopy: { headline: 'Image headline', disclosure: source.requiredDisclaimer },
    };
    expect(() => validatePlanningProofCopyConsistency(selected, [source], valid)).not.toThrow();
    expect(() => validatePlanningProofCopyConsistency(selected, [source], {
      ...valid,
      imageCopy: { headline: 'Image headline' },
    })).toThrow('canonical disclosure');
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
