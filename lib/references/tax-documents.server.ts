import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TAX_DOCUMENT_REFERENCES, type TaxDocumentSelection } from './tax-documents';

/** Only approved, repository-seeded document pixels can enter this attachment slot. */
export async function prepareTaxDocumentReference(selection?: TaxDocumentSelection) {
  if (selection === undefined || selection === 'none') return null;
  const reference = TAX_DOCUMENT_REFERENCES.find(item => item.id === selection);
  if (!reference) throw new Error('Unknown tax-document reference.');
  const buffer = await readFile(path.join(process.cwd(), 'assets', 'tax-documents', reference.fileName));
  if (createHash('sha256').update(buffer).digest('hex') !== reference.sha256) {
    throw new Error('Tax-document reference does not match its approved seed.');
  }
  const fileName = `tax-document-${reference.fileName}`;
  return {
    prompt: `
DOCUMENT-ONLY REFERENCE: ${reference.id}; version=${reference.version}; sha256=${reference.sha256}.
The attachment named ${fileName} is a document-structure exemplar, NOT a TRA human source, ad layout, proof or approved copy.
Use only its paper/envelope geometry, hierarchy, spacing and physical construction for the planned tax document.
Do not copy IRS seals/logos, names, addresses, SSNs, signatures, case/notice/caller numbers, balances, barcodes, postage marks, source wording or claims. Do not invent replacements.
Leave sensitive fields blank. Use only exact document wording explicitly provided in the planned brief; otherwise leave document text regions blank. No blurry pseudo-text, microprint or filler marks.
Keep the selected medium and composition. Preserve believable paper edges, folds, perspective, shadows and hand contact when relevant. Add no extra sheets, props, badges or checkmarks beyond the planned concept.
Document realism must not imply government affiliation, a real customer notice, a debt balance or a verified outcome.
`,
    appendTo(form: FormData) {
      form.append('image[]', new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' }), fileName);
    },
  };
}
