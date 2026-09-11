import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProofLibraryError, ProofRecordCard, proofLibraryLoadFailureMessage } from '@/components/proof-library/proof-library';
import { createProofEditFields, normalizeProofTextareaEdit, proofEditValues } from '@/components/proof-library/proof-library';
import type { ProofRecord } from '@/lib/proof/types';

const base = { tags: [], status: 'ACTIVE' as const, createdAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:00:00.000Z' };
const render = (record: ProofRecord) => renderToStaticMarkup(createElement(ProofRecordCard, { record }));

describe('Proof Library UI', () => {
  it('renders original review punctuation and line breaks without rewriting', () => {
    const id = `proof_${'a'.repeat(32)}`;
    const html = render({ ...base, id, type: 'review', originalReviewText: 'Exact wording—unchanged.\nSecond line.' });
    expect(html).toContain('Exact wording—unchanged.\nSecond line.');
    expect(html).toContain('Deactivate');
    expect(html).toContain(`aria-label="Edit proof ${id}"`);
    expect(html).toContain(`aria-label="Deactivate proof ${id}"`);
  });

  it('labels verified facts separately from approved advertising wording', () => {
    const html = render({ ...base, id: `proof_${'b'.repeat(32)}`, type: 'case-study', title: 'Case A', verifiedFacts: ['Verified fact.', 'Verified fact.'], approvedClaimWording: 'Approved wording.', sourceNote: 'Source A.' });
    expect(html).toContain('Verified facts');
    expect(html).toContain('Verified fact.');
    expect(html).toContain('Approved advertising wording');
    expect(html).toContain('Approved wording.');
    expect((html.match(/Verified fact\./g) ?? [])).toHaveLength(2);
  });

  it('retains stored line endings when a textarea value is unchanged', () => {
    expect(normalizeProofTextareaEdit('First\r\nSecond\rThird', 'First\nSecond\nThird')).toBe('First\r\nSecond\rThird');
    expect(normalizeProofTextareaEdit('First\r\nSecond', 'Edited')).toBe('Edited');
  });

  it('retains multiline field values when unchanged', () => {
    const stored = 'First\r\nSecond';
    expect(normalizeProofTextareaEdit(stored, 'First\nSecond')).toBe(stored);
  });

  it('retains fact identity after an earlier fact is removed', () => {
    const fields = createProofEditFields(['Remove me', 'Second\r\nline'], '');
    expect(proofEditValues(fields.slice(1))).toEqual(['Second\r\nline']);
  });

  it('keeps a comma-bearing tag as one editable field', () => {
    const [field] = createProofEditFields(['paid, social'], '');
    expect(proofEditValues([{ ...field, value: 'paid, social campaign' }])).toEqual(['paid, social campaign']);
  });

  it('announces asynchronous failures to assistive technology', () => {
    const html = renderToStaticMarkup(createElement(ProofLibraryError, { children: proofLibraryLoadFailureMessage }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('No changes can be made until it loads successfully.');
  });
});
