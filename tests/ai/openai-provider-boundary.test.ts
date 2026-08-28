import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApprovedTraReferenceCreativeImage } from '@/lib/ai/openai';
import type { StoredMediaFile } from '@/lib/media/types';

const TRA_SOURCE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x54, 0x52, 0x41,
]);

const source: StoredMediaFile = {
  fileName: `media_${'a'.repeat(32)}.png`,
  buffer: Buffer.from(TRA_SOURCE_BYTES),
  mimeType: 'image/png',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('approved TRA final image-provider boundary', () => {
  it('attaches exactly the one approved TRA source passed by the route gate', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const output = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateApprovedTraReferenceCreativeImage({
      source,
      primaryFormat: 'direct-response',
      context: 'APPROVED TRA COMPANY CONTEXT\nSTRUCTURED LAYOUT BLUEPRINT',
      copy: {
        headline: 'Approved headline',
        primaryText: 'Approved primary text',
        description: 'Approved description',
      },
    });

    expect(result).toEqual(output);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(options?.body).toBeInstanceOf(FormData);

    const formData = options?.body as FormData;
    expect(formData.get('quality')).toBe('high');
    const images = formData.getAll('image[]');
    expect(images).toHaveLength(1);
    expect(images[0]).toBeInstanceOf(File);
    const attached = images[0] as File;
    expect(attached.name).toBe(`approved-tra-source-${source.fileName}`);
    expect(Buffer.from(await attached.arrayBuffer())).toEqual(TRA_SOURCE_BYTES);
    expect(String(formData.get('prompt'))).toContain('APPROVED TRA COMPANY CONTEXT');
    expect(String(formData.get('prompt'))).toContain('STRUCTURED LAYOUT BLUEPRINT');
  });
});
