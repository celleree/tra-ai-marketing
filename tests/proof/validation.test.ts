import { describe, expect, it } from 'vitest';
import {
  isApprovedCaseStudyClaim,
  isProofId,
  isVerbatimReviewExcerpt,
  parseCaseStudyProofDraft,
  parseReviewProofDraft,
  requireVerbatimReviewExcerpt,
} from '@/lib/proof/validation';

describe('proof validation', () => {
  it('preserves exact original review text and leaves missing metadata absent', () => {
    const originalReviewText = '  Clear, patient — and truly helpful!\nNo pressure.  ';
    const parsed = parseReviewProofDraft({ originalReviewText });

    expect(parsed).toEqual({ originalReviewText });
    expect(parsed?.originalReviewText).toBe(originalReviewText);
  });

  it('accepts only exact Review excerpts on whole sentence or whole line boundaries', () => {
    const original = 'They answered all of my questions, clearly and patiently. Another sentence.';

    expect(isVerbatimReviewExcerpt(original, 'They answered all of my questions, clearly and patiently.')).toBe(true);
    expect(isVerbatimReviewExcerpt(original, 'Another sentence.')).toBe(true);
    expect(isVerbatimReviewExcerpt(original, 'all of my questions, clearly')).toBe(false);
    expect(isVerbatimReviewExcerpt(original, 'All of my questions, clearly')).toBe(false);
    expect(isVerbatimReviewExcerpt(original, '')).toBe(false);
    expect(requireVerbatimReviewExcerpt(original, 'Another sentence.')).toBe(
      'Another sentence.'
    );
    expect(() =>
      requireVerbatimReviewExcerpt(original, 'answered every question')
    ).toThrow('whole sentence or whole line boundaries');
  });

  it('preserves negation and qualification context instead of accepting arbitrary substrings', () => {
    const negative = 'I did not save $10,000.';
    expect(isVerbatimReviewExcerpt(negative, negative)).toBe(true);
    expect(isVerbatimReviewExcerpt(negative, 'save $10,000.')).toBe(false);
    expect(isVerbatimReviewExcerpt(negative, '$10,000.')).toBe(false);

    const qualified = 'I may save $10,000 depending on my final IRS outcome.';
    expect(isVerbatimReviewExcerpt(qualified, qualified)).toBe(true);
    expect(isVerbatimReviewExcerpt(qualified, 'save $10,000 depending on my final IRS outcome.')).toBe(false);
  });

  it('allows exact whole lines and consecutive source-bound sentences without normalizing text', () => {
    const original = 'Straightforward help—no pressure.\nVery responsive. Clear explanations.';

    expect(isVerbatimReviewExcerpt(original, 'Straightforward help—no pressure.')).toBe(true);
    expect(isVerbatimReviewExcerpt(original, 'Very responsive.')).toBe(true);
    expect(isVerbatimReviewExcerpt(original, 'Very responsive. Clear explanations.')).toBe(true);
    expect(isVerbatimReviewExcerpt(original, 'help—no pressure.\nVery')).toBe(false);
    expect(isVerbatimReviewExcerpt(original, 'help - no pressure. Very')).toBe(false);
  });

  it('requires explicit permission before storing display attribution', () => {
    expect(
      parseReviewProofDraft({
        originalReviewText: 'Helpful.',
        attribution: { display: 'J. D.', allowed: true },
      })
    ).toMatchObject({ attribution: { display: 'J. D.', allowed: true } });
    expect(
      parseReviewProofDraft({
        originalReviewText: 'Helpful.',
        attribution: { display: 'J. D.', allowed: false },
      })
    ).toBeNull();
  });

  it('keeps verified facts separate from approved advertising wording', () => {
    const approvedClaimWording =
      '  TRA helped the client understand the next steps.  ';
    const parsed = parseCaseStudyProofDraft({
      title: 'Internal case A',
      verifiedFacts: ['Client received three IRS notices.', 'TRA reviewed the notices.'],
      approvedClaimWording,
      sourceNote: 'Approved case file A.',
    });

    expect(parsed?.verifiedFacts).toEqual([
      'Client received three IRS notices.',
      'TRA reviewed the notices.',
    ]);
    expect(parsed?.approvedClaimWording).toBe(approvedClaimWording);
    expect(
      isApprovedCaseStudyClaim(
        parsed!.approvedClaimWording,
        approvedClaimWording
      )
    ).toBe(true);
    expect(
      isApprovedCaseStudyClaim(
        parsed!.approvedClaimWording,
        'TRA resolved the client’s tax debt.'
      )
    ).toBe(false);
  });

  it('rejects missing proof content and invalid stable IDs', () => {
    expect(parseReviewProofDraft({ originalReviewText: '   ' })).toBeNull();
    expect(parseCaseStudyProofDraft({ title: 'Incomplete' })).toBeNull();
    expect(isProofId(`proof_${'a'.repeat(32)}`)).toBe(true);
    expect(isProofId('proof_review_123')).toBe(false);
  });
});
