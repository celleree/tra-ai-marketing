import type { CreativeReferenceAnalysis } from '@/lib/ai/openai';
import { TAX_DOCUMENT_PLANNING_GUIDANCE } from '@/lib/references/tax-documents';
import { auditCreativePortfolio } from '@/lib/ai/portfolio-auditor';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import { referenceSelectionSchema, resolveReferenceSelection, type ReferencePlanningCandidate } from '@/lib/references/planning';
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
${TAX_DOCUMENT_PLANNING_GUIDANCE}
Consider multiple alternatives internally, then return the strongest concepts first. Select strategically distinct fits to the supplied approved TRA context; do not make performance predictions or call concepts likely winners.
The SO WHAT outcome chain must directly shape both the copy and visualDirection for every concept.
Plan proposition first: conceptDetails.angle describes the strategic framing; proposition states the particular reason to care or act, not a category label. Connect mainMessage and any objection addressed (null if none) to the existing painPoint, emotion, awareness and SO WHAT outcome chain.
Make visualArchetype, visualMechanism, subject, environment and compositionInstructions explicit and consistent with execution and visualDirection. Describe the mechanism that makes the proposition visible, exact planned subjects/props and their spatial hierarchy. For graphic concepts, describe the graphic field as the environment. These are rendering directions, not additional copy or factual evidence.
Prefer approved TRA humans when they strengthen the proposition, without a fixed human/graphic ratio. Use tax paperwork only when it materially helps the concept; do not default to desks, paper or next-step messaging.
Plan the portfolio globally around distinct reasons to care or act: vary problem/outcome framing, objections, emotions, awareness and propositions. Strong ideas may share a category or layout. Compare mechanisms, subjects, archetypes and CTA approaches separately; headline swaps, recolors, person swaps or minor rearrangements do not create a new marketing idea.
Use a human only when hasApprovedHumanSource is true, and then only as an approved supplied TRA source. When false, every subjectSource must be non-human. Never invent or borrow a person's identity.
Treat reference/layout analysis only as design and structural guidance. Do not carry over third-party identity, branding, exact copy, people, claims, or evidence.
The creativeContext may contain both USER CREATIVE DIRECTION and APPROVED TRA COMPANY CONTEXT. User direction and source/reference analysis are creative inputs, not factual approval. Only claims or proof explicitly present in approved company claims/proof fields support factual statements.
Unsupported claims and analysis unknowns are unavailable; do not infer or fill them in. Never invent testimonials, quotes, statistics, dollar amounts, outcomes, endorsements, government affiliation, guarantees, or other evidence.
Proof-like, review-like, statistics-like, and comparison formats remain valid when strategically useful, but express them without unsupported numeric or testimonial claims.
Do not restrict concepts to the analysis category. Ground every factual statement only in explicitly approved company claims/proof fields within creativeContext.
Return exactly the requested count with sequential indexes beginning at 1.
When referenceCatalog is supplied, choose referenceChoices.angleSource and layoutSource independently (null means original). References support the proposition; they do not dictate it. Give user-priority references first consideration, not exclusive use. Same-reference, different-reference, one-original and fully original choices are all valid. Do not force reference use or uniqueness across ads. Explain the choices, including relevant unused user references, in selectionReason. The renderer receives only the selected design-only blueprint; reference angles, people, branding, logos, copy, claims, testimonials, pricing and proof cannot supply output content or factual approval.
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
  hasApprovedHumanSource: boolean,
  referenceCatalog?: ReferencePlanningCandidate[]
): PlannedCreativeConcept | null => {
  if (!isRecord(value) || !hasOnly(value, ['index', 'format', 'copy', 'strategy', 'selectionReason', ...(referenceCatalog ? ['referenceChoices'] : [])])) return null;
  if (value.index !== expectedIndex || typeof value.format !== 'string' || !isCreativeFormat(value.format)) return null;
  if (!isRecord(value.copy) || !hasOnly(value.copy, ['primaryText', 'headline', 'description'])) return null;
  const primaryText = parseRequiredText(value.copy.primaryText);
  const headline = parseRequiredText(value.copy.headline);
  if (!primaryText || !headline || typeof value.copy.description !== 'string' || value.copy.description.length > MAX_TEXT_LENGTH) return null;
  const strategy = parseCreativeStrategy(value.strategy, hasApprovedHumanSource);
  const selectionReason = parseRequiredText(value.selectionReason);
  if (!strategy?.conceptDetails || !selectionReason) return null;
  if (referenceCatalog) {
    try { strategy.referenceSelection = resolveReferenceSelection(value.referenceChoices, referenceCatalog); } catch { return null; }
  }
  const copy: CreativeCopy = { primaryText, headline, description: value.copy.description.trim() };
  return { index: expectedIndex, format: value.format, copy, strategy, selectionReason };
};

async function requestCreativeBatch(args: {
  count: number;
  context: string;
  analysis: CreativeReferenceAnalysis;
  hasApprovedHumanSource: boolean;
  referenceCatalog?: ReferencePlanningCandidate[];
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
      // Bound paid reasoning/output while allowing larger supported batches more room.
      max_output_tokens: 4096 + 2048 * args.count,
      store: false,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: PLANNER_RULES }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({
          requestedCount: args.count,
          hasApprovedHumanSource: args.hasApprovedHumanSource,
          creativeContext: args.context,
          referenceAnalysis: args.analysis,
          ...(args.referenceCatalog ? { referenceCatalog: args.referenceCatalog } : {}),
        }, null, 2) }] },
      ],
      text: { format: { type: 'json_schema', name: 'tra_creative_batch_plan', strict: true, schema: {
        type: 'object', additionalProperties: false, required: ['creatives'], properties: {
          creatives: { type: 'array', minItems: args.count, maxItems: args.count, items: {
            type: 'object', additionalProperties: false,
            required: ['index', 'format', 'copy', 'strategy', 'selectionReason', ...(args.referenceCatalog ? ['referenceChoices'] : [])],
            properties: {
              ...(args.referenceCatalog ? { referenceChoices: referenceSelectionSchema(args.referenceCatalog.map(item => item.referenceId)) } : {}),
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

  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.status !== 'completed') {
    throw new Error('Creative planning did not complete. No images were generated.');
  }
  const output = extractResult(payload);
  if (output.refusal) throw new Error(`OpenAI refused the creative batch plan: ${output.refusal}`);
  if (!output.text) throw new Error('OpenAI returned no creative batch plan.');
  let parsed: unknown;
  try { parsed = JSON.parse(output.text); } catch { throw new Error('OpenAI returned malformed creative batch plan JSON.'); }
  if (!isRecord(parsed) || !hasOnly(parsed, ['creatives']) || !Array.isArray(parsed.creatives) || parsed.creatives.length !== args.count) {
    throw new Error(`OpenAI returned an invalid creative batch plan; expected exactly ${args.count} creatives.`);
  }
  const creatives = parsed.creatives.map((value, index) => parseConcept(value, index + 1, args.hasApprovedHumanSource, args.referenceCatalog));
  if (creatives.some((creative) => !creative)) throw new Error('OpenAI returned an invalid creative batch plan concept.');
  return { creatives: creatives as PlannedCreativeConcept[], plannerModel: model, reasoningEffort: 'medium' };
}

export async function planCreativeBatch(args: Parameters<typeof requestCreativeBatch>[0]): Promise<CreativeBatchPlan> {
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const plan = await requestCreativeBatch({ ...args, context: args.context + feedback });
    const portfolioAudit = await auditCreativePortfolio(plan.creatives);
    const issue = getCreativeDiversityIssue(plan.creatives, portfolioAudit);
    if (!issue) return { ...plan, portfolioAudit };
    if (attempt === 1) throw new Error(`Portfolio remains insufficiently distinct after one planning repair: ${issue}. No images were generated.`);
    feedback = `\nPORTFOLIO REPAIR: ${issue}\nPreserve strong ideas; replace repeated hypotheses with genuinely different grounded propositions. Do not relabel or paraphrase duplicates.\n${JSON.stringify(portfolioAudit)}`;
  }
  throw new Error('Portfolio planning did not complete.');
}
