import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeLayoutReference } from '@/lib/ai/layout-analyzer';
import type { StoredMediaFile } from '@/lib/media/types';

const source: StoredMediaFile = {
  fileName: `media_${'a'.repeat(32)}.png`,
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  mimeType: 'image/png',
};

const blueprint = {
  version: 1,
  composition: {
    flow: 'TEXT_LEFT_VISUAL_RIGHT',
    balance: 'ASYMMETRIC',
    imageTextBalance: 'BALANCED',
  },
  regions: [
    {
      role: 'HUMAN_PLACEHOLDER',
      xPct: 58,
      yPct: 8,
      widthPct: 40,
      heightPct: 80,
      alignment: 'CENTER',
      emphasis: 'HIGH',
      crop: 'WAIST_UP',
      overlapsOtherRegions: false,
    },
  ],
  whitespace: 'MODERATE',
  textDensity: 'SPARSE',
  ctaTreatment: 'ROUNDED_RECTANGLE',
  backgroundMechanisms: ['GEOMETRIC_SHAPE'],
  imageTreatments: ['CUTOUT'],
  typography: {
    headlineScale: 'EXTRA_LARGE',
    headlineWeight: 'BOLD',
    headlineAlignment: 'LEFT',
    hierarchyLevels: 2,
    contrast: 'HIGH',
  },
  spacing: {
    outerMargin: 'GENEROUS',
    regionGap: 'MODERATE',
    alignmentGrid: 'LEFT_EDGE',
  },
  reusableMechanisms: ['ASYMMETRIC_SHAPE_DIVIDER'],
  restrictedElementsPresent: {
    humanIdentity: true,
    thirdPartyLogoOrBranding: true,
    exactCopy: true,
    trademark: false,
    claimOrProof: true,
  },
};

const responsesPayload = (value: unknown) => ({
  output: [
    {
      content: [{ type: 'output_text', text: JSON.stringify(value) }],
    },
  ],
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('layout analyzer provider boundary', () => {
  it('uses a low-reasoning, low-detail vision request with strict structured output', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'gpt-5.6-terra');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(responsesPayload(blueprint)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await analyzeLayoutReference(source);

    expect(result.regions[0].role).toBe('HUMAN_PLACEHOLDER');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(options?.body)) as {
      model: string;
      reasoning: { effort: string };
      input: Array<{ content: Array<Record<string, unknown>> }>;
      text: { format: { type: string; strict: boolean; schema: Record<string, unknown> } };
    };
    expect(body.model).toBe('gpt-5.6-terra');
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.additionalProperties).toBe(false);

    const userContent = body.input[1].content;
    const imagePart = userContent.find((part) => part.type === 'input_image');
    expect(imagePart).toEqual(
      expect.objectContaining({
        detail: 'low',
        image_url: `data:image/png;base64,${source.buffer.toString('base64')}`,
      })
    );
    const developerText = String(body.input[0].content[0].text);
    expect(developerText).toContain('Do NOT perform creative strategy');
    expect(developerText).toContain('HUMAN_PLACEHOLDER geometry');
    expect(developerText).toContain('Never output its contents');
  });

  it('rejects analyzer output that tries to carry person identity downstream', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            responsesPayload({
              ...blueprint,
              regions: [{ ...blueprint.regions[0], identity: 'External person' }],
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    await expect(analyzeLayoutReference(source)).rejects.toThrow(/invalid keys/i);
  });
});
