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

  it('accepts only contiguous, case-sensitive, exact review excerpts', () => {
    const original = 'They answered all of my questions, clearly and patiently.';

    expect(isVerbatimReviewExcerpt(original, 'all of my questions, clearly')).toBe(true);
    expect(isVerbatimReviewExcerpt(original, 'All of my questions, clearly')).toBe(false);
    expect(isVerbatimReviewExcerpt(original, 'answered my questions')).toBe(false);
    expect(isVerbatimReviewExcerpt(original, '')).toBe(false);
    expect(requireVerbatimReviewExcerpt(original, 'clearly and patiently.')).toBe(
      'clearly and patiently.'
    );
    expect(() =>
      requireVerbatimReviewExcerpt(original, 'answered every question')
    ).toThrow('contiguous exact substring');
  });

  it('does not normalize punctuation or line breaks for excerpt matching', () => {
    const original = 'Straightforward help—no pressure.\nVery responsive.';

    expect(isVerbatimReviewExcerpt(original, 'help—no pressure.\nVery')).toBe(true);
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
