import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { eligibleVideoPassageProof, ProofLibraryError, ProofRecordCard, ReviewCsvImport, VideoPassageCandidateCard, proofLibraryLoadFailureMessage } from '@/components/proof-library/proof-library';
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

  it('provides an accessible, CSV-only review import control', () => {
    const html = renderToStaticMarkup(createElement(ReviewCsvImport, { onImported: () => {} }));
    expect(html).toContain('Import reviews from CSV');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".csv,text/csv"');
    expect(html).toContain('required=""');
    expect(html).toContain('Required: <code>originalReviewText</code>. Optional:');
    expect(html).toContain('pipe-separated <code>tags</code>');
    expect(html).toContain('Quote fields containing commas, quotes, or line breaks.');
    expect(html).toContain('Imports up to 100 reviews in one batch.');
    expect(html).toContain('Original review text is preserved exactly as supplied.');
  });

  it('renders stored passage, lifecycle, server-derived link health, and eligible relinking controls', () => {
    const approved = { ...base, id: `proof_${'c'.repeat(32)}`, type: 'review' as const, advertisingUseApproved: true, originalReviewText: 'Approved proof.' };
    const inactive = { ...base, id: `proof_${'d'.repeat(32)}`, type: 'review' as const, status: 'INACTIVE' as const, advertisingUseApproved: true, originalReviewText: 'Inactive proof.' };
    const candidate = { version: 1 as const, id: 'video-passage_candidate', status: 'LINKED' as const, linkHealth: 'CHANGED' as const, source: { locator: { version: 1 as const, sourceVideoMediaId: 'media', sourceVideoContentHash: 'a', analyzerFingerprintSha256: 'b' }, library: { id: 'library', version: 1 as const } }, passage: { startSegmentIndex: 0, endSegmentIndex: 1, startMs: 1_000, endMs: 3_500, segments: [{ segmentIndex: 0, startMs: 1_000, endMs: 2_000, text: 'Exact first segment.' }, { segmentIndex: 1, startMs: 2_100, endMs: 3_500, text: 'Exact second segment.' }] }, link: { proofId: approved.id, proofType: 'review' as const, proofUpdatedAt: '2026-09-09T12:00:00.000Z' }, createdAt: base.createdAt, updatedAt: base.updatedAt };
    const html = renderToStaticMarkup(createElement(VideoPassageCandidateCard, { candidate, items: [approved, inactive], pending: false, onMutate: () => {} }));
    expect(html).toContain('00:00–00:03'); expect(html).toContain('Exact first segment. Exact second segment.');
    expect(html).toContain('LINKED'); expect(html).toContain('Link health: Linked Proof changed');
    expect(html).toContain(`aria-label="Eligible Proof for ${candidate.id}"`); expect(html).toContain(`review: ${approved.id}`); expect(html).not.toContain(`review: ${inactive.id}`);
    expect(html).toContain('Dismiss candidate');
  });

  it('preserves dismissed passage candidates and exposes reopen only', () => {
    const candidate = { version: 1 as const, id: 'dismissed', status: 'DISMISSED' as const, linkHealth: 'UNLINKED' as const, source: { locator: { version: 1 as const, sourceVideoMediaId: 'media', sourceVideoContentHash: 'a', analyzerFingerprintSha256: 'b' }, library: { id: 'library', version: 1 as const } }, passage: { startSegmentIndex: 0, endSegmentIndex: 0, startMs: 0, endMs: 1_000, segments: [{ segmentIndex: 0, startMs: 0, endMs: 1_000, text: 'Preserved passage.' }] }, createdAt: base.createdAt, updatedAt: base.updatedAt };
    const html = renderToStaticMarkup(createElement(VideoPassageCandidateCard, { candidate, items: [], pending: false, onMutate: () => {} }));
    expect(html).toContain('Preserved passage.'); expect(html).toContain('Reopen candidate'); expect(html).not.toContain('Dismiss candidate');
  });

  it('filters eligible Proof to active, explicitly advertising-approved records', () => {
    expect(eligibleVideoPassageProof([{ ...base, id: 'active-approved', type: 'review', advertisingUseApproved: true, originalReviewText: 'Yes' }, { ...base, id: 'active-unapproved', type: 'review', originalReviewText: 'No' }, { ...base, id: 'inactive-approved', type: 'review', status: 'INACTIVE', advertisingUseApproved: true, originalReviewText: 'No' }])).toMatchObject([{ id: 'active-approved' }]);
  });
});
