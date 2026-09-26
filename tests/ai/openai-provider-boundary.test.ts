import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApprovedTraReferenceCreativeImage } from '@/lib/ai/openai';
import { generateApprovedTraVideoFrameCreativeImage } from '@/lib/ai/video-frame-generation';
import { generateLegacyPromptOnlyCreativeImage } from '@/lib/ai/legacy-copy-image-generation';
import { buildCreativeRenderBrief, formatCreativeRenderBrief } from '@/lib/creatives/render-brief';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { StoredMediaFile } from '@/lib/media/types';
import { getVideoFrameIntegrity } from '@/lib/video/frame-cache';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';
import { resolveCreativeLogoGeometry } from '@/lib/creatives/logo-placement';

const TRA_SOURCE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x54, 0x52, 0x41,
]);

const source: StoredMediaFile = {
  fileName: `media_${'a'.repeat(32)}.png`,
  buffer: Buffer.from(TRA_SOURCE_BYTES),
  mimeType: 'image/png',
};

const expectImageCopyOnly = (prompt: string) => {
  expect(prompt).toContain('Image headline');
  expect(prompt).toContain('Short support');
  expect(prompt).toContain('Learn more');
  expect(prompt).not.toContain('Primary text:');
  expect(prompt).not.toContain('Description:');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('approved TRA final image-provider boundary', () => {
  it('gives the legacy provider the same resolved bottom-right panel geometry', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ b64_json: TRA_SOURCE_BYTES.toString('base64') }] }));
    vi.stubGlobal('fetch', fetchMock);
    const geometry = resolveCreativeLogoGeometry('PORTRAIT_4_5', 'bottom-right', 200, 100);
    const result = await generateLegacyPromptOnlyCreativeImage({
      primaryFormat: 'direct-response', placement: 'PORTRAIT_4_5', context: 'Approved context',
      copy: { primaryText: 'Body', headline: 'Headline', description: '' }, logoGeometry: geometry,
    });
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).prompt as string;
    expect(prompt).toContain(`x=${geometry.panel.left}..${geometry.panel.left + geometry.panel.width - 1}`);
    expect(prompt).toContain('bottom-right overlay rectangle');
    expect(result.prompt).toBe(prompt);
  });

  it('gives the reference provider the Stories content and logo bounds', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: TRA_SOURCE_BYTES.toString('base64') }] })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateApprovedTraReferenceCreativeImage({
      source, primaryFormat: 'direct-response', placement: 'VERTICAL_9_16', context: 'Approved context',
      copy: { headline: 'Image headline', shortSupport: 'Short support', cta: 'Learn more' },
      logoGeometry: resolveCreativeLogoGeometry('VERTICAL_9_16', 'top-left', 200, 100),
    });
    const prompt = String((fetchMock.mock.calls[0][1].body as FormData).get('prompt'));
    expect(prompt).toContain('x=70..1081, y=287..1330');
    expect(prompt).toContain('x=105..401, y=322..503');
    expect(prompt).not.toContain('left 27%');
    expectImageCopyOnly(prompt);
    expectImageCopyOnly(result.prompt);
  });

  it('keeps E2 Meta-only sentinel copy out of the actual image-provider prompt', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: TRA_SOURCE_BYTES.toString('base64') }] })));
    vi.stubGlobal('fetch', fetchMock);
    const e2Concept: PlannedCreativeConcept = {
      index: 1, format: 'direct-response', selectionReason: 'Boundary regression',
      copy: { headline: 'Meta headline', primaryText: 'META_PRIMARY_SENTINEL', description: 'META_DESCRIPTION_SENTINEL' },
      adCopy: { headline: 'Meta headline', primaryText: 'META_PRIMARY_SENTINEL', description: 'META_DESCRIPTION_SENTINEL' },
      imageCopy: { headline: 'IMAGE_ONLY_HEADLINE' },
      strategy: { category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer', painPoint: 'Uncertainty',
        desiredOutcome: 'Clarity', emotion: 'Relief', hook: 'Understand options', cta: 'Talk to TRA', offer: null,
        soWhat: { surfaceMessage: 'Understand the issue', functionalConsequence: 'Review options', meaningfulOutcome: 'Clear next step' },
        execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'minimal-graphic', textDensity: 'low',
          ctaTreatment: 'inline', typographyHierarchy: 'headline-dominant' }, visualDirection: 'Simple graphic' },
    };
    const context = formatCreativeRenderBrief(buildCreativeRenderBrief({ concept: e2Concept }));
    const result = await generateApprovedTraReferenceCreativeImage({
      source, primaryFormat: e2Concept.format, placement: 'SQUARE_1_1', context,
      copy: e2Concept.imageCopy!,
    });
    const prompt = String((fetchMock.mock.calls[0][1].body as FormData).get('prompt'));
    expect(prompt).toContain('IMAGE_ONLY_HEADLINE');
    expect(prompt).not.toContain('META_PRIMARY_SENTINEL');
    expect(prompt).not.toContain('META_DESCRIPTION_SENTINEL');
    expect(result.prompt).toBe(prompt);
  });

  it.each(['none', 'irs-notice-v1'] as const)('keeps TRA identity separate from the selected document: %s', async taxDocumentReference => {
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
      taxDocumentReference,
      source,
      primaryFormat: 'direct-response',
      placement: 'PORTRAIT_4_5',
      context: 'APPROVED TRA COMPANY CONTEXT\nSTRUCTURED LAYOUT BLUEPRINT',
      copy: {
        headline: 'Image headline',
        shortSupport: 'Short support',
        cta: 'Learn more',
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
    expect(images).toHaveLength(taxDocumentReference === 'none' ? 1 : 2);
    if (taxDocumentReference !== 'none') {
      expect((images[1] as File).name).toBe('tax-document-irs-notice-v1.jpg');
      expect(result.prompt).toContain('NOT a TRA human source');
    } else expect(result.prompt).not.toContain('DOCUMENT-ONLY REFERENCE');
    expect(images[0]).toBeInstanceOf(File);
    const attached = images[0] as File;
    expect(attached.name).toBe(`approved-tra-source-${source.fileName}`);
    expect(Buffer.from(await attached.arrayBuffer())).toEqual(TRA_SOURCE_BYTES);
    expect(String(formData.get('prompt'))).toContain('APPROVED TRA COMPANY CONTEXT');
    expect(String(formData.get('prompt'))).toContain('STRUCTURED LAYOUT BLUEPRINT');
    expect(String(formData.get('prompt'))).toContain('4:5 canvas (1024x1280)');
    expect(String(formData.get('prompt'))).toContain('do not crop or stretch a square design');
    expectImageCopyOnly(String(formData.get('prompt')));
  });

  it('recomposes approved TRA video frames for the requested vertical placement using image copy only', async () => {
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
      sourceOverlay: { version: 2, status: 'CLEAN' },
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
      logoGeometry: resolveCreativeLogoGeometry('VERTICAL_9_16', 'top-left', 200, 100),
      context: 'Approved company context',
      copy: {
        headline: 'Image headline',
        shortSupport: 'Short support',
        cta: 'Learn more',
      },
    });

    const formData = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(formData.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(formData.get('size')).toBe('1152x2048');
    expect(String(formData.get('prompt'))).toContain('9:16 canvas (1152x2048)');
    expect(formData.get('prompt')).toContain('x=70..1081, y=287..1330');
    expect(formData.get('prompt')).toContain('x=105..401, y=322..503');
    expect(String(formData.get('prompt'))).toContain('rather than cropping or stretching a square design');
    expectImageCopyOnly(String(formData.get('prompt')));
    expect(result.prompt).toBe(formData.get('prompt'));
    expect(result.model).toBe(formData.get('model'));
    expect(result.providerFrames).toMatchObject([frame]);
  });
});
