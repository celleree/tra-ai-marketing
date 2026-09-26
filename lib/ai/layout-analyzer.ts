import { fetchWithProviderUsage } from '@/lib/ai/provider-telemetry';
import type { StoredMediaFile } from '@/lib/media/types';
import {
  LAYOUT_BLUEPRINT_JSON_SCHEMA,
  parseLayoutBlueprint,
  type LayoutBlueprint,
} from '@/lib/layouts/blueprint';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const ANALYZER_RULES = `
You are a narrow layout-analysis system for advertising images.
Your only job is to convert the attached external/reference ad into reusable visual geometry and design-mechanism metadata.

Do NOT perform creative strategy.
Do NOT decide an angle, hook, offer, claim, persona, audience, tax-relief message, or campaign hypothesis.
Do NOT transcribe or quote visible ad copy.
Do NOT name or describe the identity, appearance, ethnicity, age, gender, clothing, or distinguishing features of any person.
Do NOT identify or reproduce any advertiser, logo, brand, trademark, product name, testimonial, statistic, claim, or proof content.

If a person exists, represent that person only as HUMAN_PLACEHOLDER geometry using the region coordinates/crop fields. Nothing about identity may be encoded.
If a logo/brand/copy/trademark/claim is visible, only mark the corresponding boolean in restrictedElementsPresent. Never output its contents.

Coordinates are integer percentages of the full canvas:
- xPct/yPct = top-left position from 0 to 100
- widthPct/heightPct = occupied size from 1 to 100

Capture only composition, hierarchy, whitespace, text/image balance, CTA geometry/treatment, cards/overlays, background mechanisms, image treatment, typography hierarchy, spacing/alignment, and other controlled reusable layout mechanisms expressible by the schema.
`;

const getApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  return apiKey;
};

export const getLayoutAnalysisModel = () =>
  process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';

const getErrorMessage = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message || `OpenAI request failed with ${response.status}.`;
  } catch {
    return `OpenAI request failed with ${response.status}.`;
  }
};

const extractOutputText = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'output_text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
    }
  }

  return '';
};

const imageDataUrl = (source: StoredMediaFile) =>
  `data:${source.mimeType};base64,${source.buffer.toString('base64')}`;

export async function analyzeLayoutReference(
  source: StoredMediaFile
): Promise<LayoutBlueprint> {
  const response = await fetchWithProviderUsage('layout-analysis', `${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getLayoutAnalysisModel(),
      store: false,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'developer',
          content: [{ type: 'input_text', text: ANALYZER_RULES }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Extract only the reusable layout/design mechanism into the required schema.',
            },
            {
              type: 'input_image',
              image_url: imageDataUrl(source),
              detail: 'low',
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'layout_blueprint_v1',
          strict: true,
          schema: LAYOUT_BLUEPRINT_JSON_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) throw new Error(await getErrorMessage(response));

  const text = extractOutputText(await response.json());
  if (!text) throw new Error('OpenAI returned no layout blueprint.');

  return parseLayoutBlueprint(JSON.parse(text));
}
