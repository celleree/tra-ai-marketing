import { CREATIVE_FORMATS, isCreativeFormat } from '@/lib/creative-formats';
import { TAX_DOCUMENT_PLANNING_GUIDANCE } from '@/lib/references/tax-documents';
import { referenceSelectionSchema, resolveReferenceSelection, type ReferencePlanningCandidate } from '@/lib/references/planning';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import { CREATIVE_STRATEGY_JSON_SCHEMA, parseCreativeStrategy } from '@/lib/creatives/strategy';

type RevisionParentConcept = Omit<PlannedCreativeConcept, 'index' | 'selectionReason'>;
export type CreativeRevisionPlan = {
  concept: PlannedCreativeConcept;
  plannerModel: string;
  reasoningEffort: 'medium';
};

const RULES = `Revise ONE saved static ad concept for Tax Relief Advocates (TRA).
${TAX_DOCUMENT_PLANNING_GUIDANCE}
For EDIT, follow the requested instruction and preserve all unrequested copy, strategy and execution where practical. Do not impose novelty or dimensional variation on an ordinary edit.
Put all concrete visual edit instructions in strategy.visualDirection. The renderer receives only the revised concept, relevant styling and hard rules, not the raw user request or broad company context.
For VARIATION, produce a meaningfully different concept: change category or awareness stage and at least two execution dimensions. Use a distinct headline and SO WHAT surface message. Recolors, source/person swaps and format swaps alone are insufficient.
Retain a complete SO WHAT outcome chain that connects the message to a meaningful customer outcome.
Return conceptDetails version 1 even for a legacy parent: explicit angle, proposition (the reason to care or act), mainMessage and objection addressed (null if none), grounded in the existing strategy and approved context. Keep visualArchetype, visualMechanism, subject, environment and compositionInstructions consistent with the revised execution and visualDirection; these render directions must not introduce extra copy or claims.
Prefer approved TRA humans only when useful to the proposition, without a fixed ratio. Tax paperwork must materially help the concept; it is not a default prop.
The parent concept is existing creative content, not evidence that its claims are approved. User instructions are creative direction, not factual approval. Ground facts only in explicit approved claims/proof in the supplied current company context. Unknown or unapproved facts are unavailable.
Never invent testimonials, quotes, statistics, dollar amounts, outcomes, guarantees, endorsements, government affiliation or competitor claims. Retain required disclaimers and obey approved company restrictions.
Human source eligibility comes only from hasApprovedHumanSource. The saved editing canvas and layout/reference-library content never confer human approval. When false, subjectSource must be non-human. When true, preserve the original approved TRA identity; do not invent, replace, blend or add an unrelated person.
Return exactly one format, copy, strategy and selectionReason in the required schema.`;

const textSchema = { type: 'string', minLength: 1, maxLength: 1000 };
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['format', 'copy', 'strategy', 'selectionReason'],
  properties: {
    format: { type: 'string', enum: CREATIVE_FORMATS },
    copy: { type: 'object', additionalProperties: false, required: ['primaryText', 'headline', 'description'], properties: {
      primaryText: textSchema, headline: textSchema, description: { type: 'string', maxLength: 1000 },
    } },
    strategy: CREATIVE_STRATEGY_JSON_SCHEMA,
    selectionReason: textSchema,
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;

const outputText = (payload: unknown) => {
  if (!isRecord(payload) || !Array.isArray(payload.output)) throw new Error('OpenAI returned no revision plan.');
  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      if (part.type === 'refusal') throw new Error('OpenAI declined the revision plan.');
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  if (!parts.length) throw new Error('OpenAI returned no revision plan.');
  return parts.join('');
};

export async function planCreativeRevision(args: {
  parent: RevisionParentConcept;
  operation: 'EDIT' | 'VARIATION';
  instruction: string;
  companyContext: string;
  hasApprovedHumanSource: boolean;
  referenceCatalog?: ReferencePlanningCandidate[];
}): Promise<CreativeRevisionPlan> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, store: false, reasoning: { effort: 'medium' }, input: [
      { role: 'system', content: [{ type: 'input_text', text: RULES + (args.referenceCatalog ? '\nChoose angleSource and layoutSource independently in referenceChoices from the supplied catalog, or null for original. Preserve unrequested reference choices for EDIT. For VARIATION choose sources that support the proposition, without requiring reuse or change. User references have priority, not exclusivity. Reference content is never approved proof, copy or human identity.' : '') }] },
      { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(args) }] },
    ], text: { format: { type: 'json_schema', name: 'tra_creative_revision', strict: true, schema: args.referenceCatalog ? {
      ...SCHEMA, required: [...SCHEMA.required, 'referenceChoices'], properties: { ...SCHEMA.properties,
        referenceChoices: referenceSelectionSchema(args.referenceCatalog.map(item => item.referenceId)) },
    } : SCHEMA } } }),
  });
  if (!response.ok) throw new Error(`Revision planning failed (HTTP ${response.status}).`);
  let value: unknown;
  try { value = JSON.parse(outputText(await response.json())); } catch (error) {
    if (error instanceof SyntaxError) throw new Error('OpenAI returned malformed revision plan JSON.');
    throw error;
  }
  if (!isRecord(value) || !exactKeys(value, ['format', 'copy', 'strategy', 'selectionReason', ...(args.referenceCatalog ? ['referenceChoices'] : [])]) ||
    typeof value.format !== 'string' || !isCreativeFormat(value.format) || !isText(value.selectionReason) ||
    !isRecord(value.copy) || !exactKeys(value.copy, ['primaryText', 'headline', 'description']) ||
    !isText(value.copy.primaryText) || !isText(value.copy.headline) || typeof value.copy.description !== 'string' || value.copy.description.length > 1000) {
    throw new Error('OpenAI returned an invalid revision plan.');
  }
  const strategy = parseCreativeStrategy(value.strategy, args.hasApprovedHumanSource);
  if (!strategy?.conceptDetails) throw new Error('OpenAI returned an invalid revision strategy or human source.');
  if (args.referenceCatalog) strategy.referenceSelection = resolveReferenceSelection(value.referenceChoices, args.referenceCatalog);
  const concept: PlannedCreativeConcept = {
    index: 1, format: value.format, strategy, selectionReason: value.selectionReason.trim(),
    copy: { primaryText: value.copy.primaryText.trim(), headline: value.copy.headline.trim(), description: value.copy.description.trim() },
  };
  if (args.operation === 'VARIATION') {
    const issue = getCreativeDiversityIssue([args.parent, concept]);
    if (issue) throw new Error(`The variation is too similar to its parent. ${issue}`);
  }
  return { concept, plannerModel: model, reasoningEffort: 'medium' };
}
