import {
  CREATIVE_CATEGORIES,
  CREATIVE_CATEGORY_LABELS,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import type { StoredMediaFile } from '@/lib/media/types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const ANGLE_GUIDE: Record<CreativeCategoryId, string> = {
  'customer-problems': 'The main hook centers on a pain, frustration, risk, or problem the customer is experiencing.',
  'desired-outcomes': 'The main hook centers on the result, relief, improvement, or end state the customer wants.',
  objections: 'The creative directly addresses a concern, hesitation, misconception, or reason someone may not act.',
  'testimonials-proof': 'The creative is primarily structured around customer proof, reviews, results, social proof, credibility, or evidence.',
  statistics: 'The creative leads with a number, statistic, data point, percentage, or quantitative fact.',
  comparisons: 'The creative compares options, approaches, products, old versus new, us versus them, or side-by-side alternatives.',
  'price-offer-positioning': 'The main hook is an offer, price, cost framing, deal, promotion, savings, consultation, or value proposition.',
  'feature-led': 'The creative leads with a product or service feature, capability, process, or concrete functional benefit.',
  emotional: 'The main mechanism is an emotion such as fear, stress, frustration, relief, confidence, security, or hope.',
  educational: 'The creative primarily teaches, explains, answers a question, gives steps, or provides useful information.',
  'aspirational-lifestyle': 'The creative sells a better future, identity, lifestyle, freedom, status, or aspirational state.',
  curiosity: 'The creative relies on a knowledge gap, surprising idea, unanswered question, reveal, secret, or open loop.',
  urgency: 'The creative primarily pushes immediate action using time sensitivity, deadlines, scarcity, or a reason to act now.',
  'before-after': 'The creative is built around transformation, contrast between previous and improved states, or before versus after.',
  'customer-personas': 'The creative speaks directly to a specific type of person, role, life situation, occupation, or audience segment.',
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

const getErrorMessage = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message || `OpenAI request failed with ${response.status}.`;
  } catch {
    return `OpenAI request failed with ${response.status}.`;
  }
};

export async function classifyReferenceCreativeAngle(
  source: StoredMediaFile
): Promise<CreativeCategoryId> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  const angleList = CREATIVE_CATEGORIES.map(
    (angle) => `- ${angle}: ${CREATIVE_CATEGORY_LABELS[angle]} — ${ANGLE_GUIDE[angle]}`
  ).join('\n');

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        {
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: `Classify an advertising reference image by its SINGLE dominant marketing angle. Choose exactly one angle from the fixed list below. Focus on the main persuasive idea, not visual design style. If multiple angles appear, choose the one that most strongly drives the hook. Do not judge whether the ad is good or successful.\n\n${angleList}`,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Classify this reference creative into exactly one fixed angle folder.',
            },
            {
              type: 'input_image',
              image_url: `data:${source.mimeType};base64,${source.buffer.toString('base64')}`,
              detail: 'high',
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'reference_angle_classification',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              angle: {
                type: 'string',
                enum: [...CREATIVE_CATEGORIES],
              },
            },
            required: ['angle'],
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
    throw new Error('OpenAI returned no angle classification.');
  }

  const parsed = JSON.parse(text) as { angle?: string };
  if (!parsed.angle || !CREATIVE_CATEGORIES.includes(parsed.angle as CreativeCategoryId)) {
    throw new Error('OpenAI returned an invalid angle classification.');
  }

  return parsed.angle as CreativeCategoryId;
}
