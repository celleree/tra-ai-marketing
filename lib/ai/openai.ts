import {
  CREATIVE_CATEGORIES,
  CREATIVE_CATEGORY_LABELS,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import type { CreativeFormatId } from '@/lib/creative-formats';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import {
  CREATIVE_PLACEMENT_SPECS,
  type CreativePlacement,
} from '@/lib/creatives/placements';
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
  dominantCategory: CreativeCategoryId;
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

const categoryList = CREATIVE_CATEGORIES.map(
  (category) => `- ${category}: ${CREATIVE_CATEGORY_LABELS[category]}`
).join('\n');

const REFERENCE_ANALYSIS_RULES = `
Analyze an uploaded advertising creative that will be used as CREATIVE INSPIRATION for a Tax Relief Advocates (TRA) ad.
The uploaded image may belong to another advertiser. It is not the brand identity for the output.
Your job is to understand the creative mechanism, not to copy the ad.
Describe what is visibly present and separate observations from guesses.
Focus on layout, hierarchy, hook, CTA/offer presentation, typography feel, imagery, spacing, visual rhythm, and why the creative is easy or difficult to understand at a glance.
Classify the ad into exactly one dominant creative category from the fixed list below.
Do not assume the reference ad performed well.
Do not infer private performance data, customer outcomes, advertiser intent, or facts that are not visible.
If third-party logos, trademarks, people, exact wording, testimonial claims, statistics, or outcome claims appear, put those concepts in avoid rather than suggesting they be copied.
The resulting analysis will be used to create an original TRA ad, so preserve only high-level creative mechanisms and structural ideas.

Creative categories:
${categoryList}
`;

const TRA_SOURCE_ANALYSIS_RULES = `
Analyze an uploaded EXISTING Tax Relief Advocates (TRA) ad as a BRAND AND CONTENT ANCHOR.
The output will be new TRA ads, but this uploaded TRA ad is NOT the creative layout template.
Identify visible TRA identity cues, logo or company-name treatment, brand colors, service/message cues, offer or CTA cues, imagery cues, and any other information that helps a new ad remain clearly TRA.
Describe the current layout for awareness, but do not recommend preserving its composition, hierarchy, spacing, or exact visual structure.
Classify the current ad into one dominant creative category from the fixed list below, even though later generated ads may use other categories.
Do not invent facts or claims that are not visible.
Put unsupported claims, exact wording that should not be repeated, and any uncertain details in avoid or unknowns.
In preserve, prioritize TRA identity and factual/service cues rather than the current ad's layout.

Creative categories:
${categoryList}
`;

const analyzeCreative = async (
  source: StoredMediaFile,
  context: string,
  rules: string,
  instruction: string,
  schemaName: string
): Promise<CreativeReferenceAnalysis> => {
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
          content: [{ type: 'input_text', text: rules }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `${instruction}\n\nUser direction:\n${context}`,
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
          name: schemaName,
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
              dominantCategory: {
                type: 'string',
                enum: [...CREATIVE_CATEGORIES],
              },
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
              'dominantCategory',
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
    throw new Error('OpenAI returned no creative analysis.');
  }

  return JSON.parse(text) as CreativeReferenceAnalysis;
};

export async function analyzeReferenceCreative(
  source: StoredMediaFile,
  context: string
): Promise<CreativeReferenceAnalysis> {
  return analyzeCreative(
    source,
    context,
    REFERENCE_ANALYSIS_RULES,
    'Analyze this uploaded reference ad as creative inspiration for an original TRA adaptation.',
    'tra_reference_analysis'
  );
}

export async function analyzeTraSourceCreative(
  source: StoredMediaFile,
  context: string
): Promise<CreativeReferenceAnalysis> {
  return analyzeCreative(
    source,
    context,
    TRA_SOURCE_ANALYSIS_RULES,
    'Analyze this existing TRA ad as the TRA brand/content anchor. Do not treat its layout as the template for the new ads.',
    'tra_source_analysis'
  );
}

const TRA_COPY_RULES = `
You are writing Meta ad copy for Tax Relief Advocates (TRA), a tax-relief service business.
Use plain, clear consumer language.
Useful customer themes include stress about IRS notices or tax problems, wanting clarity, peace of mind, responsive help, clear explanations, professionalism, and no-pressure communication.
The assigned creative category is the PRIMARY messaging direction for each variation. Formats are presentation structures only.
Never fabricate a testimonial, review quote, statistic, dollar amount, customer result, expert endorsement, government affiliation, competitor claim, or guarantee.
Do not imply every customer gets the same outcome.
Treat the user's context as creative direction, not proof of a factual claim unless it explicitly labels a claim as approved.
For testimonial/review formats, use customer-centered themes without inventing a quote or named person.
For statistics/data formats, do not invent a number; use a data-inspired structure without unsupported figures.
Keep each variation meaningfully different from the others.
If the analysis is a TRA source anchor, use it for TRA identity and factual/message cues, not as a requirement to repeat that ad's layout or hook.
If the analysis is a reference ad, use its concept only as inspiration and never copy third-party wording, logos, trademarks, people, or unsupported claims.
`;

export async function generateCreativeCopy(
  plan: PlannedCreativeFormat[],
  context: string,
  analysis: CreativeReferenceAnalysis
): Promise<Map<number, CreativeCopy>> {
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const requested = plan.map((item) => ({
    index: item.index,
    category: CREATIVE_CATEGORY_LABELS[item.category],
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
      reasoning: { effort: 'medium' },
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
              )}\n\nCreative analysis:\n${JSON.stringify(
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

const logoSafeAreaRules = (reserveLogoArea: boolean) =>
  reserveLogoArea
    ? `
Approved-logo placement:
- Do NOT draw, imitate, typeset, or invent a TRA logo in the generated image.
- Leave the upper-left area clear of important text, faces, CTA buttons, and essential imagery: approximately the left 27% of the canvas and top 13% of the canvas.
- The exact approved TRA logo asset will be composited into that reserved space after image generation. Treat that space as a deliberate brand lockup area.
`
    : '';

const buildApprovedTraSourceImagePrompt = (
  primaryFormat: CreativeFormatId,
  secondaryFormat: CreativeFormatId | undefined,
  placement: CreativePlacement,
  context: string,
  copy: CreativeCopy,
  reserveLogoArea: boolean
) => {
  const placementSpec = CREATIVE_PLACEMENT_SPECS[placement];
  return `
Create an ORIGINAL ${placementSpec.aspectRatio} static Facebook/Instagram ad for Tax Relief Advocates (TRA).

Compose natively for the ${placementSpec.aspectRatio} canvas (${placementSpec.width}x${placementSpec.height}). Recompose the hierarchy, subject, copy, CTA, and logo space for this ratio; do not crop or stretch a square design.

The ONE attached image is a validated, TRA-owned reference and is the only raw source image supplied to this generation call. Layout references, external reference-library images, and video frames are not attached.

Primary creative format: ${CREATIVE_FORMAT_LABELS[primaryFormat]}
${
  secondaryFormat
    ? `Secondary creative format: ${CREATIVE_FORMAT_LABELS[secondaryFormat]}`
    : ''
}
User direction: ${context}

Use this approved ad copy as the messaging source:
Headline: ${copy.headline}
Primary text idea: ${copy.primaryText}
Description: ${copy.description}

Approved-source rules:
- The attached TRA image is the only allowed raw visual and the only approved human-identity source for this generation call.
- If the output depicts a person, preserve the visible identity from the attached TRA image. Do not invent, replace, blend, or add another person.
- Do not recreate the attached image verbatim or depend on its old layout unless the text direction explicitly asks for a high-level structural cue.
- Make the result clearly original and specific to TRA.
${logoSafeAreaRules(reserveLogoArea)}
TRA guardrails:
- Do not invent a testimonial, review quote, statistic, dollar amount, customer outcome, expert endorsement, government affiliation, competitor claim, or guarantee.
- If the assigned format normally relies on evidence that is not supplied, preserve the format concept without inventing the evidence.
- Do not imply universal tax-debt results.
- Keep the design credible, consumer-friendly, and readable on a phone.
- Strong visual hierarchy. Avoid tiny text and clutter.
- The only company/brand name that may appear is Tax Relief Advocates or TRA.
`;
};

const appendImage = (
  formData: FormData,
  source: StoredMediaFile,
  fileName: string
) => {
  formData.append(
    'image[]',
    new Blob([new Uint8Array(source.buffer)], { type: source.mimeType }),
    fileName
  );
};

const generateImageEdit = async (
  prompt: string,
  images: Array<{ source: StoredMediaFile; fileName: string }>,
  providerSize: string
): Promise<Buffer> => {
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const formData = new FormData();
  formData.set('model', model);
  formData.set('prompt', prompt);
  formData.set('size', providerSize);
  formData.set('quality', 'high');
  formData.set('output_format', 'png');

  for (const image of images) {
    appendImage(formData, image.source, image.fileName);
  }

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
};

export async function generateApprovedTraReferenceCreativeImage(args: {
  source: StoredMediaFile;
  primaryFormat: CreativeFormatId;
  secondaryFormat?: CreativeFormatId;
  placement?: CreativePlacement;
  context: string;
  copy: CreativeCopy;
  reserveLogoArea?: boolean;
}): Promise<Buffer> {
  return generateImageEdit(
    buildApprovedTraSourceImagePrompt(
      args.primaryFormat,
      args.secondaryFormat,
      args.placement ?? 'SQUARE_1_1',
      args.context,
      args.copy,
      Boolean(args.reserveLogoArea)
    ),
    [
      {
        source: args.source,
        fileName: `approved-tra-source-${args.source.fileName}`,
      },
    ],
    CREATIVE_PLACEMENT_SPECS[args.placement ?? 'SQUARE_1_1'].providerSize
  );
}
