// User-supplied exemplars approved for document structure, never factual proof.
// Versioned IDs keep saved plans tied to the original seed even as the library grows.
export const TAX_DOCUMENT_SELECTIONS = ['none', 'irs-notice-v1', 'irs-mail-v1'] as const;
export type TaxDocumentSelection = (typeof TAX_DOCUMENT_SELECTIONS)[number];

export const TAX_DOCUMENT_REFERENCES = ([
  {
    id: 'irs-notice-v1', fileName: 'irs-notice-v1.jpg', originalFileName: 'Photo 1.jpg',
    sha256: '2e529956bfb160e3168b48108ab1e2562b501d1e0b97241b635a58d8e1ea95c2',
    description: 'Single tax notice: header, recipient region, body and billing-table geometry, detachable payment section.',
    restrictedContent: ['IRS seal/logo', 'names/address', 'SSN-like digits', 'balance', 'notice/caller identifiers', 'claims'],
  },
  {
    id: 'irs-mail-v1', fileName: 'irs-mail-v1.jpg', originalFileName: 'Photo 2.jpg',
    sha256: '4aed697b38d0c67679930b0b56e9747189038257d7d6dc6fe8d003a16699299e',
    description: 'Tax-mail envelopes: paper folds, window construction, overlapping stack and physical scale.',
    restrictedContent: ['IRS seal/logo', 'addresses', 'mail identifiers/barcodes', 'penalty amount', 'postage markings'],
  },
] as const).map(reference => ({
  ...reference, source: 'user-provided chat attachment', suppliedAt: '2026-09-10',
  approvedUse: 'document-structure-only', version: 1,
}));

export const TAX_DOCUMENT_PLANNING_GUIDANCE = `Built-in tax-document references are available without uploads.
Set execution.taxDocumentReference to irs-notice-v1 for visible IRS-style notices, tax letters or tax paperwork; use irs-mail-v1 for tax-mail envelopes.
Choose none for concepts without tax documents (including unrelated generic paper). Do not introduce paperwork just because these references exist.
These assets supply document structure only, never claims, amounts, identities or government affiliation. Preserve the planned medium and choose a reference only when the concept needs it.`;
