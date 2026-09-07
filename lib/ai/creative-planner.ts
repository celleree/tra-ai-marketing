import type { CreativeReferenceAnalysis } from '@/lib/ai/openai';
import { CREATIVE_FORMATS, isCreativeFormat } from '@/lib/creative-formats';
import type { CreativeCopy } from '@/lib/creatives/generated';
import type { CreativeBatchPlan, PlannedCreativeConcept } from '@/lib/creatives/planned';
import {
  CREATIVE_STRATEGY_JSON_SCHEMA,
  parseCreativeStrategy,
} from '@/lib/creatives/strategy';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_TEXT_LENGTH = 1000;

const PLANNER_RULES = `
Plan a batch of original static Meta ad concepts for Tax Relief Advocates (TRA).
Consider multiple alternatives internally, then return the strongest concepts first. Select strategically distinct fits to the supplied approved TRA context; do not make performance predictions or call concepts likely winners.
The SO WHAT outcome chain must directly shape both the copy and visualDirection for every concept.
Nearby concepts must differ on at least one strategic dimension and two execution dimensions. Do not use superficial headline swaps, recolors, person swaps, or minor rearrangements as variation.
Use a human only when hasApprovedHumanSource is true, and then only as an approved supplied TRA source. When false, every subjectSource must be non-human. Never invent or borrow a person's identity.
Treat reference/layout analysis only as design and structural guidance. Do not carry over third-party identity, branding, exact copy, people, claims, or evidence.
The creativeContext may contain both USER CREATIVE DIRECTION and APPROVED TRA COMPANY CONTEXT. User direction and source/reference analysis are creative inputs, not factual approval. Only claims or proof explicitly present in approved company claims/proof fields support factual statements.
Unsupported claims and analysis unknowns are unavailable; do not infer or fill them in. Never invent testimonials, quotes, statistics, dollar amounts, outcomes, endorsements, government affiliation, guarantees, or other evidence.
Proof-like, review-like, statistics-like, and comparison formats remain valid when strategically useful, but express them without unsupported numeric or testimonial claims.
Do not restrict concepts to the analysis category. Ground every factual statement only in explicitly approved company claims/proof fields within creativeContext.
Return exactly the requested count with sequential indexes beginning at 1.
`;

const getApiKey = () => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  return key;
};

const getProviderError = async (response: Response) => {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message || `OpenAI request failed with ${response.status}.`;
  } catch {
    return `OpenAI request failed with ${response.status}.`;
  }
};

const extractResult = (payload: unknown): { text: string; refusal: string } => {
  if (!payload || typeof payload !== 'object') return { text: '', refusal: '' };
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return { text: '', refusal: '' };
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const value = part as { type?: unknown; text?: unknown; refusal?: unknown };
      if (value.type === 'refusal' && typeof value.refusal === 'string') {
        return { text: '', refusal: value.refusal };
      }
      if (value.type === 'output_text' && typeof value.text === 'string') {
        return { text: value.text, refusal: '' };
      }
    }
  }
  return { text: '', refusal: '' };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const parseRequiredText = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= MAX_TEXT_LENGTH ? text : null;
};

const parseConcept = (
  value: unknown,
  expectedIndex: number,
  hasApprovedHumanSource: boolean
): PlannedCreativeConcept | null => {
  if (!isRecord(value) || !hasOnly(value, ['index', 'format', 'copy', 'strategy', 'selectionReason'])) return null;
  if (value.index !== expectedIndex || typeof value.format !== 'string' || !isCreativeFormat(value.format)) return null;
  if (!isRecord(value.copy) || !hasOnly(value.copy, ['primaryText', 'headline', 'description'])) return null;
  const primaryText = parseRequiredText(value.copy.primaryText);
  const headline = parseRequiredText(value.copy.headline);
  if (!primaryText || !headline || typeof value.copy.description !== 'string' || value.copy.description.length > MAX_TEXT_LENGTH) return null;
  const strategy = parseCreativeStrategy(value.strategy, hasApprovedHumanSource);
  const selectionReason = parseRequiredText(value.selectionReason);
  if (!strategy || !selectionReason) return null;
  const copy: CreativeCopy = { primaryText, headline, description: value.copy.description.trim() };
  return { index: expectedIndex, format: value.format, copy, strategy, selectionReason };
};

export async function planCreativeBatch(args: {
  count: number;
  context: string;
  analysis: CreativeReferenceAnalysis;
  hasApprovedHumanSource: boolean;
}): Promise<CreativeBatchPlan> {
  if (!Number.isInteger(args.count) || args.count < 2 || args.count > 30) {
    throw new Error('Creative batch count must be an integer from 2 to 30.');
  }
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning: { effort: 'medium' },
      store: false,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: PLANNER_RULES }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({
          requestedCount: args.count,
          hasApprovedHumanSource: args.hasApprovedHumanSource,
          creativeContext: args.context,
          referenceAnalysis: args.analysis,
        }, null, 2) }] },
      ],
      text: { format: { type: 'json_schema', name: 'tra_creative_batch_plan', strict: true, schema: {
        type: 'object', additionalProperties: false, required: ['creatives'], properties: {
          creatives: { type: 'array', minItems: args.count, maxItems: args.count, items: {
            type: 'object', additionalProperties: false,
            required: ['index', 'format', 'copy', 'strategy', 'selectionReason'],
            properties: {
              index: { type: 'integer', minimum: 1, maximum: args.count },
              format: { type: 'string', enum: CREATIVE_FORMATS },
              copy: { type: 'object', additionalProperties: false, required: ['primaryText', 'headline', 'description'], properties: {
                primaryText: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH },
                headline: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH },
                description: { type: 'string', maxLength: MAX_TEXT_LENGTH },
              } },
              strategy: CREATIVE_STRATEGY_JSON_SCHEMA,
              selectionReason: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH },
            },
          } },
        },
      } } },
    }),
  });
  if (!response.ok) throw new Error(await getProviderError(response));

  const output = extractResult(await response.json());
  if (output.refusal) throw new Error(`OpenAI refused the creative batch plan: ${output.refusal}`);
  if (!output.text) throw new Error('OpenAI returned no creative batch plan.');
  let parsed: unknown;
  try { parsed = JSON.parse(output.text); } catch { throw new Error('OpenAI returned malformed creative batch plan JSON.'); }
  if (!isRecord(parsed) || !hasOnly(parsed, ['creatives']) || !Array.isArray(parsed.creatives) || parsed.creatives.length !== args.count) {
    throw new Error(`OpenAI returned an invalid creative batch plan; expected exactly ${args.count} creatives.`);
  }
  const creatives = parsed.creatives.map((value, index) => parseConcept(value, index + 1, args.hasApprovedHumanSource));
  if (creatives.some((creative) => !creative)) throw new Error('OpenAI returned an invalid creative batch plan concept.');
  return { creatives: creatives as PlannedCreativeConcept[], plannerModel: model, reasoningEffort: 'medium' };
}
