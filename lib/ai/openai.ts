import type { CreativeFormatId } from '@/lib/creative-formats';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import type { PlannedCreativeFormat } from '@/lib/creatives/generate-request';
import type { CreativeCopy } from '@/lib/creatives/generated';
import type { StoredMediaFile } from '@/lib/media/types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface CreativeReferenceAnalysis {
  summary: string;
  visibleText: string[];
  visualStructure: string;
  hookOrAngle: string;
  offerOrCta: string;
  styleNotes: string;
  preserve: string[];
  avoid: string[];
  unknowns: string[];
}

const getApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
  return apiKey;
};

const getErrorMessage = async (response: Response) => {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string };
    };
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

const referenceImageDataUrl = (source: StoredMediaFile) =>
  `data:${source.mimeType};base64,${source.buffer.toString('base64')}`;

const REFERENCE_ANALYSIS_RULES = `
Analyze an uploaded advertising creative for Tax Relief Advocates (TRA).
Your job is to understand the creative mechanism, not to copy the ad.
Describe what is visibly present and separate observations from guesses.
Focus on layout, hierarchy, hook, CTA/offer presentation, typography feel, imagery, spacing, visual rhythm, and why the creative is easy or difficult to understand at a glance.
Do not assume the reference ad performed well.
Do not infer private performance data, customer outcomes, advertiser intent, or facts that are not visible.
If third-party logos, trademarks, people, exact wording, testimonial claims, statistics, or outcome claims appear, put those concepts in avoid rather than suggesting they be copied.
The resulting analysis will be used to create an original TRA ad, so preserve only high-level creative mechanisms and structural ideas.
`;

export async function analyzeReferenceCreative(
  source: StoredMediaFile,
  context: string
): Promise<CreativeReferenceAnalysis> {
  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        {
          role: 'developer',
          content: [{ type: 'input_text', text: REFERENCE_ANALYSIS_RULES }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Analyze this source creative. User direction for the TRA adaptation:\n${context}`,
            },
            {
              type: 'input_image',
              image_url: referenceImageDataUrl(source),
              detail: 'high',
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'tra_reference_analysis',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              visibleText: { type: 'array', items: { type: 'string' } },
              visualStructure: { type: 'string' },
              hookOrAngle: { type: 'string' },
              offerOrCta: { type: 'string' },
              styleNotes: { type: 'string' },
              preserve: { type: 'array', items: { type: 'string' } },
              avoid: { type: 'array', items: { type: 'string' } },
              unknowns: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'summary',
              'visibleText',
              'visualStructure',
              'hookOrAngle',
              'offerOrCta',
              'styleNotes',
              'preserve',
              'avoid',
              'unknowns',
            ],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  const text = extractOutputText(await response.json());
  if (!text) {
    throw new Error('OpenAI returned no reference analysis.');
  }

  return JSON.parse(text) as CreativeReferenceAnalysis;
}

const TRA_COPY_RULES = `
You are writing Meta ad copy for Tax Relief Advocates (TRA), a tax-relief service business.
Use plain, clear consumer language.
Useful customer themes include stress about IRS notices or tax problems, wanting clarity, peace of mind, responsive help, clear explanations, professionalism, and no-pressure communication.
Never fabricate a testimonial, review quote, statistic, dollar amount, customer result, expert endorsement, government affiliation, competitor claim, or guarantee.
Do not imply every customer gets the same outcome.
Treat the user's context as creative direction, not proof of a factual claim unless it explicitly labels a claim as approved.
For testimonial/review formats, use customer-centered themes without inventing a quote or named person.
For statistics/data formats, do not invent a number; use a data-inspired structure without unsupported figures.
Keep each variation meaningfully different and appropriate to its assigned creative format.
Use the reference analysis for creative structure and inspiration, but never copy third-party wording, logos, trademarks, people, or unsupported claims from the source.
`;

export async function generateCreativeCopy(
  plan: PlannedCreativeFormat[],
  context: string,
  analysis: CreativeReferenceAnalysis
): Promise<Map<number, CreativeCopy>> {
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-5.6-terra';
  const requested = plan.map((item) => ({
    index: item.index,
    primaryFormat: CREATIVE_FORMAT_LABELS[item.primaryFormat],
    secondaryFormat: item.secondaryFormat
      ? CREATIVE_FORMAT_LABELS[item.secondaryFormat]
      : null,
  }));

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        {
          role: 'developer',
          content: [{ type: 'input_text', text: TRA_COPY_RULES }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Create copy for these ad variations:\n${JSON.stringify(
                requested,
                null,
                2
              )}\n\nReference creative analysis:\n${JSON.stringify(
                analysis,
                null,
                2
              )}\n\nUser direction:\n${context}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'tra_creative_copy',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              creatives: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer' },
                    primaryText: { type: 'string' },
                    headline: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: [
                    'index',
                    'primaryText',
                    'headline',
                    'description',
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ['creatives'],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  const payload = await response.json();
  const text = extractOutputText(payload);
  if (!text) {
    throw new Error('OpenAI returned no copy output.');
  }

  const parsed = JSON.parse(text) as {
    creatives?: Array<CreativeCopy & { index: number }>;
  };
  const copyByIndex = new Map<number, CreativeCopy>();

  for (const item of parsed.creatives || []) {
    if (
      Number.isInteger(item.index) &&
      typeof item.primaryText === 'string' &&
      typeof item.headline === 'string' &&
      typeof item.description === 'string'
    ) {
      copyByIndex.set(item.index, {
        primaryText: item.primaryText,
        headline: item.headline,
        description: item.description,
      });
    }
  }

  for (const item of plan) {
    if (!copyByIndex.has(item.index)) {
      throw new Error(`OpenAI did not return copy for variation ${item.index}.`);
    }
  }

  return copyByIndex;
}

const buildImagePrompt = (
  primaryFormat: CreativeFormatId,
  secondaryFormat: CreativeFormatId | undefined,
  context: string,
  copy: CreativeCopy,
  analysis: CreativeReferenceAnalysis
) => `
Create an ORIGINAL square static Facebook/Instagram ad for Tax Relief Advocates (TRA), using the attached source image as a real visual reference.

Primary creative format: ${CREATIVE_FORMAT_LABELS[primaryFormat]}
${
  secondaryFormat
    ? `Secondary creative format: ${CREATIVE_FORMAT_LABELS[secondaryFormat]}`
    : ''
}
User direction: ${context}

Reference analysis:
Summary: ${analysis.summary}
Visual structure: ${analysis.visualStructure}
Hook/angle: ${analysis.hookOrAngle}
Style notes: ${analysis.styleNotes}
High-level ideas worth preserving: ${analysis.preserve.join('; ') || 'none'}
Elements to avoid copying: ${analysis.avoid.join('; ') || 'none'}

Use this approved ad copy as the messaging source:
Headline: ${copy.headline}
Primary text idea: ${copy.primaryText}
Description: ${copy.description}

Reference-image rules:
- Use the source image and the analysis for high-level visual inspiration such as composition, hierarchy, spacing, visual rhythm, or creative mechanism when useful.
- Do not recreate the source verbatim.
- Do not copy third-party logos, brand names, trademarks, people, or exact source wording.
- Make the output clearly original and specific to Tax Relief Advocates.

TRA guardrails:
- Do not invent a testimonial, review quote, statistic, dollar amount, customer outcome, expert endorsement, government affiliation, competitor claim, or guarantee.
- If the assigned format normally relies on evidence that is not supplied, preserve the format concept without inventing the evidence.
- Do not imply universal tax-debt results.
- Keep the design credible, consumer-friendly, and readable on a phone.
- Strong visual hierarchy. Avoid tiny text and clutter.
- The only company/brand name that may appear is Tax Relief Advocates or TRA.
`;

export async function generateReferenceCreativeImage(args: {
  source: StoredMediaFile;
  primaryFormat: CreativeFormatId;
  secondaryFormat?: CreativeFormatId;
  context: string;
  copy: CreativeCopy;
  analysis: CreativeReferenceAnalysis;
}): Promise<Buffer> {
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const formData = new FormData();
  formData.set('model', model);
  formData.set(
    'prompt',
    buildImagePrompt(
      args.primaryFormat,
      args.secondaryFormat,
      args.context,
      args.copy,
      args.analysis
    )
  );
  formData.set('size', '1024x1024');
  formData.set('quality', 'medium');
  formData.set('output_format', 'png');
  formData.append(
    'image[]',
    new Blob([new Uint8Array(args.source.buffer)], {
      type: args.source.mimeType,
    }),
    args.source.fileName
  );

  const response = await fetch(`${OPENAI_BASE_URL}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  const payload = (await response.json()) as {
    data?: Array<{ b64_json?: string }>;
  };
  const base64 = payload.data?.[0]?.b64_json;
  if (!base64) {
    throw new Error('OpenAI returned no generated image.');
  }

  return Buffer.from(base64, 'base64');
}
