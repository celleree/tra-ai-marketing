import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { TAX_DOCUMENT_REFERENCES } from '@/lib/references/tax-documents';
import { prepareTaxDocumentReference } from '@/lib/references/tax-documents.server';

describe('seeded tax documents', () => {
  it.each(['none', undefined] as const)('does not load or instruct for %s', async selection => {
    expect(await prepareTaxDocumentReference(selection)).toBeNull();
  });

  it.each(TAX_DOCUMENT_REFERENCES)('loads original approved bytes for $id without an upload', async reference => {
    const prepared = await prepareTaxDocumentReference(reference.id);
    const form = new FormData();
    prepared!.appendTo(form);
    const files = form.getAll('image[]') as File[];
    expect(files).toHaveLength(1);
    const buffer = Buffer.from(await files[0].arrayBuffer());
    expect(createHash('sha256').update(buffer).digest('hex')).toBe(reference.sha256);
    expect((await sharp(buffer).metadata()).format).toBe('jpeg');
    expect(prepared!.prompt).toContain(reference.sha256);
    expect(prepared!.prompt).toContain('NOT a TRA human source');
    expect(prepared!.prompt).toContain('Leave sensitive fields blank');
  });

  it('rejects unknown references', async () => {
    await expect(prepareTaxDocumentReference('missing' as never)).rejects.toThrow('Unknown tax-document');
  });
});
