import { describe, expect, it } from 'vitest';
import {
  CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS,
  CREATIVE_HUMAN_REVIEW_CHECKLIST_LABELS,
  parseCreativeHumanReview,
  parseCreativeHumanReviewChecklist,
  parseCreativeLifecycle,
} from '@/lib/creatives/human-review';

const checklist = (result: 'PASS' | 'FAIL' = 'PASS') =>
  Object.fromEntries(
    CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS.map((key) => [key, result])
  );

const reviewedAt = '2026-09-07T12:34:56.789Z';

describe('creative human review contract', () => {
  it('exports a user-facing label for every exact checklist key', () => {
    expect(Object.keys(CREATIVE_HUMAN_REVIEW_CHECKLIST_LABELS)).toEqual(
      CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS
    );
    expect(Object.values(CREATIVE_HUMAN_REVIEW_CHECKLIST_LABELS).every(Boolean)).toBe(true);
  });

  it('accepts pending and outcome-consistent final reviews', () => {
    expect(parseCreativeHumanReview({ status: 'PENDING' })).toEqual({ status: 'PENDING' });
    expect(parseCreativeHumanReview({
      status: 'APPROVED', reviewedAt, checklist: checklist(), notes: '  Ready to publish.  ',
    })).toEqual({
      status: 'APPROVED', reviewedAt, checklist: checklist(), notes: 'Ready to publish.',
    });
    expect(parseCreativeHumanReview({
      status: 'REJECTED', reviewedAt, checklist: { ...checklist(), textReadability: 'FAIL' },
    })).toEqual({
      status: 'REJECTED', reviewedAt, checklist: { ...checklist(), textReadability: 'FAIL' },
    });
  });

  it.each([
    ['missing checklist check', () => { const value = checklist(); delete value.textReadability; return value; }],
    ['unexpected checklist check', () => ({ ...checklist(), unrecognized: 'PASS' })],
    ['invalid checklist result', () => ({ ...checklist(), logoIntegrity: 'MAYBE' })],
  ])('rejects %s', (_label, createChecklist) => {
    expect(parseCreativeHumanReviewChecklist(createChecklist())).toBeNull();
  });

  it.each([
    ['approval with a failed check', { status: 'APPROVED', reviewedAt, checklist: { ...checklist(), placementSafety: 'FAIL' } }],
    ['rejection with every check passing', { status: 'REJECTED', reviewedAt, checklist: checklist() }],
    ['pending decision details', { status: 'PENDING', reviewedAt }],
    ['missing final review field', { status: 'APPROVED', reviewedAt }],
    ['invalid date', { status: 'APPROVED', reviewedAt: '2026-02-30T12:34:56.789Z', checklist: checklist() }],
    ['blank notes', { status: 'APPROVED', reviewedAt, checklist: checklist(), notes: '  ' }],
    ['long notes', { status: 'APPROVED', reviewedAt, checklist: checklist(), notes: 'n'.repeat(2001) }],
  ])('rejects %s', (_label, value) => {
    expect(parseCreativeHumanReview(value)).toBeNull();
  });
});

describe('creative lifecycle contract', () => {
  it('accepts valid lifecycle states', () => {
    expect(parseCreativeLifecycle({ status: 'ACTIVE', updatedAt: reviewedAt })).toEqual({ status: 'ACTIVE', updatedAt: reviewedAt });
    expect(parseCreativeLifecycle({ status: 'PAUSED', updatedAt: reviewedAt })).toEqual({ status: 'PAUSED', updatedAt: reviewedAt });
  });

  it.each([
    { status: 'ARCHIVED', updatedAt: reviewedAt },
    { status: 'ACTIVE', updatedAt: '2026-09-07' },
    { status: 'ACTIVE', updatedAt: reviewedAt, extra: true },
  ])('rejects malformed lifecycle', (value) => {
    expect(parseCreativeLifecycle(value)).toBeNull();
  });
});
