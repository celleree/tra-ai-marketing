import { describe, expect, it } from 'vitest';
import { MAX_REVIEW_CSV_BYTES, parseReviewCsv } from '@/lib/proof/review-csv';

describe('parseReviewCsv', () => {
  it('parses quoted commas, doubled quotes, and preserves multiline review text', () => {
    const original = 'Line one, "great"\r\nLine two';
    const [review] = parseReviewCsv(
      `originalReviewText,source,displayAttribution,attributionAllowed,rating,tags\r\n"${original.replaceAll('"', '""')}",Google,Sam,true,4.5,service|favorite`
    );
    expect(review).toMatchObject({
      type: 'review',
      originalReviewText: original,
      source: 'Google',
      attribution: { display: 'Sam', allowed: true },
      rating: 4.5,
      tags: ['service', 'favorite'],
    });
  });

  it('accepts a BOM on the first header while preserving review text exactly', () => {
    const original = 'First line\rSecond line\nThird line\r\nFinal line';
    const [review] = parseReviewCsv(
      `\uFEFForiginalReviewText\r\n"${original.replaceAll('"', '""')}"`
    );
    expect(review.originalReviewText).toBe(original);
  });

  it('keeps blank metadata missing and never infers attribution', () => {
    expect(parseReviewCsv('originalReviewText,source,displayAttribution,attributionAllowed\nExact text,,,')[0]).toEqual({
      type: 'review',
      originalReviewText: 'Exact text',
    });
    expect(() => parseReviewCsv('originalReviewText,displayAttribution\nExact text,Sam')).toThrow(/row 2/);
  });

  it('rejects malformed structure and invalid review rows with row numbers', () => {
    expect(() => parseReviewCsv('originalReviewText\n"unterminated')).toThrow(/row 2.*unterminated/);
    expect(() => parseReviewCsv('originalReviewText,source\nExact text')).toThrow(/row 2.*columns/);
    expect(() => parseReviewCsv('originalReviewText\n   ')).toThrow(/originalReviewText must not be blank/);
  });

  it('rejects unknown and duplicate headers and enforces row count', () => {
    expect(() => parseReviewCsv('originalReviewText,wat\ntext,x')).toThrow(/unknown header/);
    expect(() => parseReviewCsv('originalReviewText,originalReviewText\ntext,text')).toThrow(/duplicate/);
    const rows = Array.from({ length: 101 }, (_, index) => `review ${index + 1}`).join('\n');
    expect(() => parseReviewCsv(`originalReviewText\n${rows}`)).toThrow(/at most 100/);
  });

  it('enforces the byte limit', () => {
    const input = `originalReviewText\n${'x'.repeat(MAX_REVIEW_CSV_BYTES)}`;
    expect(() => parseReviewCsv(input)).toThrow(/byte limit/);
  });
});
