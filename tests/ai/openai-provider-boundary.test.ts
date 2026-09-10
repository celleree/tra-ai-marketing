import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApprovedTraReferenceCreativeImage } from '@/lib/ai/openai';
import { generateApprovedTraVideoFrameCreativeImage } from '@/lib/ai/video-frame-generation';
import type { StoredMediaFile } from '@/lib/media/types';
import { getVideoFrameIntegrity } from '@/lib/video/frame-cache';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

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
  it('gives the reference provider the Stories content and logo bounds', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: TRA_SOURCE_BYTES.toString('base64') }] })));
    vi.stubGlobal('fetch', fetchMock);
    await generateApprovedTraReferenceCreativeImage({
      source, primaryFormat: 'direct-response', placement: 'VERTICAL_9_16', context: 'Approved context',
      copy: { headline: 'Headline', primaryText: 'Primary', description: '' }, reserveLogoArea: true,
    });
    const prompt = (fetchMock.mock.calls[0][1].body as FormData).get('prompt');
    expect(prompt).toContain('x=70..1081, y=287..1330');
    expect(prompt).toContain('x=105..401, y=322..546');
    expect(prompt).not.toContain('left 27%');
  });
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
      placement: 'PORTRAIT_4_5',
      context: 'APPROVED TRA COMPANY CONTEXT\nSTRUCTURED LAYOUT BLUEPRINT',
      copy: {
        headline: 'Approved headline',
        primaryText: 'Approved primary text',
        description: 'Approved description',
      },
    });

    expect(result.buffer).toEqual(output);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(options?.body).toBeInstanceOf(FormData);

    const formData = options?.body as FormData;
    expect(formData.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(result.prompt).toBe(formData.get('prompt'));
    expect(result.model).toBe(formData.get('model'));
    expect(formData.get('quality')).toBe('high');
    expect(formData.get('size')).toBe('1024x1280');
    const images = formData.getAll('image[]');
    expect(images).toHaveLength(1);
    expect(images[0]).toBeInstanceOf(File);
    const attached = images[0] as File;
    expect(attached.name).toBe(`approved-tra-source-${source.fileName}`);
    expect(Buffer.from(await attached.arrayBuffer())).toEqual(TRA_SOURCE_BYTES);
    expect(String(formData.get('prompt'))).toContain('APPROVED TRA COMPANY CONTEXT');
    expect(String(formData.get('prompt'))).toContain('STRUCTURED LAYOUT BLUEPRINT');
    expect(String(formData.get('prompt'))).toContain('4:5 canvas (1024x1280)');
    expect(String(formData.get('prompt'))).toContain('do not crop or stretch a square design');
  });

  it('recomposes approved TRA video frames for the requested vertical placement', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      'base64'
    );
    const mediaId = `media_${'d'.repeat(32)}`;
    const frame: ApprovedTraVideoFrame = {
      frameIndex: 0,
      timestampMs: 250,
      mimeType: 'image/png',
      buffer: png,
      ...getVideoFrameIntegrity(png),
      sourceRole: 'TRA_VIDEO',
      sourceVideoMediaId: mediaId,
      sourceVideoFileName: `${mediaId}.mp4`,
      sourceVideoContentHash: 'e'.repeat(64),
      approvedHumanSource: true,
      cacheKey: `derived/video-frames/${mediaId}/${'e'.repeat(64)}/frame-000.png`,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateApprovedTraVideoFrameCreativeImage({
      frames: [frame],
      primaryFormat: 'direct-response',
      placement: 'VERTICAL_9_16',
      reserveLogoArea: true,
      context: 'Approved company context',
      copy: {
        headline: 'Get clear next steps',
        primaryText: 'Talk with TRA.',
        description: 'No-pressure consultation.',
      },
    });

    const formData = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(formData.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(formData.get('size')).toBe('1152x2048');
    expect(String(formData.get('prompt'))).toContain('9:16 canvas (1152x2048)');
    expect(formData.get('prompt')).toContain('x=70..1081, y=287..1330');
    expect(formData.get('prompt')).toContain('x=105..401, y=322..546');
    expect(String(formData.get('prompt'))).toContain('rather than cropping or stretching a square design');
    expect(result.prompt).toBe(formData.get('prompt'));
    expect(result.model).toBe(formData.get('model'));
    expect(result.providerFrames).toEqual([frame]);
  });
});
