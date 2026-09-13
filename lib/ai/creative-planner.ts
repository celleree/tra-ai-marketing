import { parseReusableReferenceAngle } from '@/lib/references/planning';
import type { CreativeReferenceAnalysis } from '@/lib/ai/openai';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import { parsePlanningSourceAnalysis } from '@/lib/creatives/planning-source-parser';
import { isApprovedHumanId, MAX_APPROVED_HUMAN_OPTIONS, type ApprovedHumanOption } from '@/lib/video/approved-human';
import { TAX_DOCUMENT_PLANNING_GUIDANCE } from '@/lib/references/tax-documents';
import { auditCreativePortfolio } from '@/lib/ai/portfolio-auditor';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import { referenceSelectionSchema, resolveReferenceSelection, type ReferencePlanningCandidate } from '@/lib/references/planning';
import { CREATIVE_FORMATS, isCreativeFormat } from '@/lib/creative-formats';
import type { CreativeCopy } from '@/lib/creatives/generated';
import { MAX_PORTFOLIO_CREATIVES, type CreativeBatchPlan, type PlannedCreativeConcept } from '@/lib/creatives/planned';
import {
  CREATIVE_STRATEGY_JSON_SCHEMA,
  parseCreativeStrategy,
} from '@/lib/creatives/strategy';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_TEXT_LENGTH = 1000;
// Compact per-concept allowance: ~1,024 tokens for the 3 copy fields, 20 strategy/
// concept text fields, selection rationale, enums/IDs and JSON; 512 for reasoning
// and detail variance. Retain 4,096 batch reasoning tokens (Responses counts both).
const planningOutputTokens = (count: number) => 4096 + 1536 * count;

const PLANNER_RULES = `
Plan a batch of original static Meta ad concepts for Tax Relief Advocates (TRA).
${TAX_DOCUMENT_PLANNING_GUIDANCE}
Consider alternatives internally; return the strongest concepts first. Select distinct fits to approved TRA context, without performance predictions or calling concepts likely winners.
The SO WHAT outcome chain must directly shape both the copy and visualDirection for every concept.
Plan proposition first: angle is strategic framing; proposition is the particular reason to care or act, not a category. Connect mainMessage and objection (null if none) to painPoint, emotion, awareness and SO WHAT.
Make visualArchetype, visualMechanism, subject and environment explicit and consistent with execution. Specify the mechanism making the proposition visible and exact subjects/props; a graphic field is an environment. These directions never add copy or evidence.
Prefer approved TRA humans when they strengthen the proposition, without a fixed human/graphic ratio. Avoid default desks, paper or next-step messaging.
Plan globally distinct problem/outcome framings, objections, emotions, awareness and propositions. Strong ideas may share a category or layout. Compare mechanisms, subjects, archetypes and CTAs separately; headline/person swaps, recolors or rearrangements are not new ideas.
Use a human only from an approved supplied TRA source (hasApprovedHumanSource) or a selected approvedHumanOptions record. Without either, every subjectSource must be non-human. Never invent or borrow a person's identity.
Treat reference/layout analysis only as design and structural guidance. Do not carry over third-party identity, branding, exact copy, people, claims, or evidence.
creativeContext separates USER CREATIVE DIRECTION from APPROVED TRA COMPANY CONTEXT. User direction and source/reference analysis are creative inputs, not factual approval. Only claims or proof explicitly present in approved company claims/proof fields support factual statements.
Unsupported claims and analysis unknowns are unavailable; do not infer or fill them in. Never invent testimonials, quotes, statistics, dollar amounts, outcomes, endorsements, government affiliation, guarantees, or other evidence.
Proof/review/statistics/comparison formats remain eligible, without unsupported numeric or testimonial claims.
Do not restrict concepts to the analysis category.
Return exactly the requested count with sequential indexes beginning at 1.
Write compact JSON: short, specific phrases for strategy/concept fields; one causal clause per SO WHAT step. Preserve distinct meanings, not repeated sentences. Put spatial hierarchy in compositionInstructions and remaining actionable treatment, lighting, crop and styling in visualDirection. Do not repeat the company brief, copy, enum labels or rationale there; retain all execution details, claim qualifications and required disclaimers.
selectionReason briefly explains marginal strategic value and source choices, not the copy or SO WHAT chain again.
Catalog reusableAngleSummary is campaign-independent inspiration, never approved evidence or selection rationale. Keep it distinct from legacy angleDescription and campaign selectionReason. When referenceCatalog is supplied, choose referenceChoices.angleSource and layoutSource independently (null means original). Give user-priority references first consideration, not exclusivity. Matched, mixed, one-original and fully original choices are valid; never force reference use or uniqueness. Explain choices and relevant unused user references in selectionReason. The renderer receives only the selected design-only blueprint; reference content never supplies identity, copy, pricing, claims, testimonials or proof.
When approvedHumanOptions is supplied, choose a listed approvedHumanId only for material credibility, relatability, explanation or emotional specificity; face availability alone is insufficient. Explain why in selectionReason. That identity replaces other supplied humans; never mix identities. Approval covers visible identity only, never claims, credentials, quotes, testimonials or outcomes. Use null for a non-human concept or an explicitly supplied approved TRA source.
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
  referenceCatalog?: ReferencePlanningCandidate[],
  approvedHumanOptions?: ApprovedHumanOption[]
): PlannedCreativeConcept | null => {
  if (!isRecord(value) || !hasOnly(value, ['index', 'format', 'copy', 'strategy', 'selectionReason', ...(referenceCatalog ? ['referenceChoices'] : []), ...(approvedHumanOptions ? ['approvedHumanId'] : [])])) return null;
  if (value.index !== expectedIndex || typeof value.format !== 'string' || !isCreativeFormat(value.format)) return null;
  if (!isRecord(value.copy) || !hasOnly(value.copy, ['primaryText', 'headline', 'description'])) return null;
  const primaryText = parseRequiredText(value.copy.primaryText);
  const headline = parseRequiredText(value.copy.headline);
  if (!primaryText || !headline || typeof value.copy.description !== 'string' || value.copy.description.length > MAX_TEXT_LENGTH) return null;
  if (isRecord(value.strategy) && 'approvedHumanId' in value.strategy) return null;
  const humanId = approvedHumanOptions ? value.approvedHumanId : null;
  if (humanId !== null && (!isApprovedHumanId(humanId) || !approvedHumanOptions?.some(option => option.id === humanId))) return null;
  const strategy = parseCreativeStrategy(value.strategy, hasApprovedHumanSource || humanId !== null);
  const selectionReason = parseRequiredText(value.selectionReason);
  if (!strategy?.conceptDetails || !selectionReason) return null;
  if (humanId !== null) {
    if (strategy.execution.subjectSource !== 'approved-tra-human') return null;
    strategy.approvedHumanId = humanId as string;
  }
  if (referenceCatalog) {
    try { strategy.referenceSelection = resolveReferenceSelection(value.referenceChoices, referenceCatalog); } catch { return null; }
  }
  const copy: CreativeCopy = { primaryText, headline, description: value.copy.description.trim() };
  return { index: expectedIndex, format: value.format, copy, strategy, selectionReason };
};

export type CreativeBatchPlannerArgs = {
  count: number;
  context: string;
  analysis: CreativeReferenceAnalysis;
  sourceAnalysis?: PlanningSourceAnalysisState;
  hasApprovedHumanSource: boolean;
  referenceCatalog?: ReferencePlanningCandidate[];
  approvedHumanOptions?: ApprovedHumanOption[];
};

export async function requestCreativeBatch(args: CreativeBatchPlannerArgs): Promise<CreativeBatchPlan> {
  const sourceAnalysis = args.sourceAnalysis === undefined ? undefined : parsePlanningSourceAnalysis(args.sourceAnalysis, undefined, true);
  if (!Number.isInteger(args.count) || args.count < 2 || args.count > MAX_PORTFOLIO_CREATIVES) {
    throw new Error(`Creative batch count must be an integer from 2 to ${MAX_PORTFOLIO_CREATIVES}.`);
  }
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  if (args.approvedHumanOptions && (args.approvedHumanOptions.length > MAX_APPROVED_HUMAN_OPTIONS
    || args.approvedHumanOptions.some(option => !isApprovedHumanId(option.id))
    || new Set(args.approvedHumanOptions.map(option => option.id)).size !== args.approvedHumanOptions.length)) {
    throw new Error('Invalid bounded approved-human options.');
  }
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning: { effort: 'medium' },
      max_output_tokens: planningOutputTokens(args.count),
      store: false,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: PLANNER_RULES }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({
          creativeContext: args.context,
          requestedCount: args.count,
          hasApprovedHumanSource: args.hasApprovedHumanSource,
          referenceAnalysis: args.analysis,
          ...(sourceAnalysis ? { sourceAnalysis, sourceAnalysisGuidance: 'Keep each source and analysis distinct. REPRESENTATIVE_VIDEO_FRAMES describes only listed still frames, not full Video Intelligence. All entries are unverified observations or design inspiration, never evidence, claims, human approval or permission to attach pixels. Existing approved-human and reference-choice rules remain authoritative.' } : {}),
          // Hashes/analyzer versions stay in the persisted catalog, not Astra's decisions.
          ...(args.referenceCatalog ? { referenceCatalog: args.referenceCatalog.map(({ referenceId, priority, angleDescription, blueprint, reusableAngle, sourceSha256 }) => {
            const angle = parseReusableReferenceAngle(reusableAngle);
            return { referenceId, priority, angleDescription, blueprint,
              ...(angle?.sourceSha256 === sourceSha256 ? { reusableAngleSummary: angle.angleSummary } : {}) };
          }) } : {}),
          ...(args.approvedHumanOptions ? { approvedHumanOptions: args.approvedHumanOptions } : {}),
        }) }] },
      ],
      text: { format: { type: 'json_schema', name: 'tra_creative_batch_plan', strict: true, schema: {
        type: 'object', additionalProperties: false, required: ['creatives'], properties: {
          // Keep invariant schema content before request-specific counts/ID enums.
          creatives: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            required: ['index', 'format', 'copy', 'strategy', 'selectionReason', ...(args.referenceCatalog ? ['referenceChoices'] : []), ...(args.approvedHumanOptions ? ['approvedHumanId'] : [])],
            properties: {
              format: { type: 'string', enum: CREATIVE_FORMATS },
              copy: { type: 'object', additionalProperties: false, required: ['primaryText', 'headline', 'description'], properties: {
                primaryText: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH },
                headline: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH },
                description: { type: 'string', maxLength: MAX_TEXT_LENGTH },
              } },
              strategy: CREATIVE_STRATEGY_JSON_SCHEMA,
              selectionReason: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH },
              index: { type: 'integer', minimum: 1, maximum: args.count },
              ...(args.approvedHumanOptions ? { approvedHumanId: { type: ['string', 'null'], enum: [null, ...args.approvedHumanOptions.map(option => option.id)] } } : {}),
              ...(args.referenceCatalog ? { referenceChoices: referenceSelectionSchema(args.referenceCatalog.map(item => item.referenceId)) } : {}),
            },
          }, minItems: args.count, maxItems: args.count },
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
  const creatives = parsed.creatives.map((value, index) => parseConcept(value, index + 1, args.hasApprovedHumanSource, args.referenceCatalog, args.approvedHumanOptions));
  if (creatives.some((creative) => !creative)) throw new Error('OpenAI returned an invalid creative batch plan concept.');
  return { creatives: creatives as PlannedCreativeConcept[], plannerModel: model, reasoningEffort: 'medium' };
}

export const creativeRepairFeedback = (
  issue: string,
  portfolioAudit: Awaited<ReturnType<typeof auditCreativePortfolio>>,
) => `\nPORTFOLIO REPAIR: ${issue}\nPreserve strong ideas; replace repeated hypotheses with genuinely different grounded propositions. Do not relabel or paraphrase duplicates.\n${JSON.stringify(portfolioAudit)}`;

export async function planCreativeBatch(args: CreativeBatchPlannerArgs): Promise<CreativeBatchPlan> {
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const plan = await requestCreativeBatch({ ...args, context: args.context + feedback });
    const portfolioAudit = await auditCreativePortfolio(plan.creatives);
    const issue = getCreativeDiversityIssue(plan.creatives, portfolioAudit);
    if (!issue) return { ...plan, portfolioAudit };
    if (attempt === 1) throw new Error(`Portfolio remains insufficiently distinct after one planning repair: ${issue}. No images were generated.`);
    feedback = creativeRepairFeedback(issue, portfolioAudit);
  }
  throw new Error('Portfolio planning did not complete.');
}
