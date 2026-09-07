import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateCreativeCopy,
  type CreativeReferenceAnalysis,
} from '@/lib/ai/openai';
import type { PlannedCreativeFormat } from '@/lib/creatives/generate-request';

const plan: PlannedCreativeFormat[] = [
  {
    index: 1,
    category: 'customer-problems',
    format: 'direct-response',
    primaryFormat: 'direct-response',
  },
];

const analysis: CreativeReferenceAnalysis = {
  summary: 'Approved TRA source context.',
  visibleText: [],
  visualStructure: 'Single clear message.',
  hookOrAngle: 'Resolve tax debt.',
  offerOrCta: 'Talk to TRA.',
  styleNotes: 'Calm and direct.',
  preserve: ['TRA grounding'],
  avoid: ['Unsupported claims'],
  unknowns: [],
  dominantCategory: 'customer-problems',
};

const responseWithCopy = {
  output: [
    {
      content: [
        {
          type: 'output_text',
          text: JSON.stringify({
            creatives: [
              {
                index: 1,
                primaryText: 'Get a clear path forward.',
                headline: 'Tax debt support from TRA',
                description: 'Talk to a TRA specialist.',
              },
            ],
          }),
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('creative copy Responses request', () => {
  it.each([
    ['uses Astra medium reasoning by default', '', 'gpt-6-astra'],
    ['preserves the text-model override', 'gpt-5.6-terra', 'gpt-5.6-terra'],
  ])('%s', async (_label, override, expectedModel) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_TEXT_MODEL', override);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(responseWithCopy), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateCreativeCopy(plan, 'Ground this in approved TRA context.', analysis)
    ).resolves.toEqual(
      new Map([
        [
          1,
          {
            primaryText: 'Get a clear path forward.',
            headline: 'Tax debt support from TRA',
            description: 'Talk to a TRA specialist.',
          },
        ],
      ])
    );

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({
      model: expectedModel,
      reasoning: { effort: 'medium' },
      store: false,
    });
    expect(body.input[1].content[0].text).toContain(
      'Ground this in approved TRA context.'
    );
    expect(body.input[1].content[0].text).toContain('Approved TRA source context.');
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'tra_creative_copy',
      strict: true,
    });
  });
});
