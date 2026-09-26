import { fetchWithProviderUsage } from '@/lib/ai/provider-telemetry';
import { parsePortfolioAudit, portfolioAuditSchema, type PortfolioAudit } from '@/lib/creatives/portfolio-audit';
import { MAX_PORTFOLIO_CREATIVES, type PlannedCreativeConcept } from '@/lib/creatives/planned';

const RULES = `Audit this TRA creative portfolio by underlying marketing meaning before rendering.
Group concepts communicating essentially the same proposition, even when they use different words, categories, people, layouts or props. Compare problem framing, outcome, objection, emotion, awareness level and reason to care or act. Explicitly examine repeated questions -> conversation -> next steps logic.
Preserve genuinely different propositions within the same category or awareness stage. A shared CTA or proven layout does not make two strategic ideas equivalent. Visual uniqueness alone does not establish strategic diversity.
For each group, summarize its shared proposition and explain its distinction from the other groups. Put near-duplicate paraphrases in the SAME group; do not invent distinctions to fulfill a requested count. Each input index must appear exactly once.
Separately report execution concentration (mechanisms, subjects, archetypes, desk/paper imagery, CTA approaches) in executionNotes. Judge whether repetition serves the propositions, without human/graphic or reference-use quotas. This is a semantic audit, not prediction of advertising performance or approval of source claims.`;

export async function auditCreativePortfolio(concepts: PlannedCreativeConcept[]): Promise<PortfolioAudit> {
  if (concepts.length < 2 || concepts.length > MAX_PORTFOLIO_CREATIVES) throw new Error(`Portfolio audit requires 2–${MAX_PORTFOLIO_CREATIVES} concepts.`);
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  const summaries = concepts.map(({ strategy, copy }, index) => ({
    index: index + 1, copy, category: strategy.category, awarenessStage: strategy.awarenessStage,
    persona: strategy.persona, painPoint: strategy.painPoint, desiredOutcome: strategy.desiredOutcome,
    emotion: strategy.emotion, soWhat: strategy.soWhat, conceptDetails: strategy.conceptDetails, execution: strategy.execution,
  }));
  const response = await fetchWithProviderUsage('portfolio-audit', model, 'https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, reasoning: { effort: 'medium' }, store: false, max_output_tokens: 4096 + 256 * concepts.length,
      input: [ { role: 'developer', content: [{ type: 'input_text', text: RULES }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(summaries) }] } ],
      text: { format: { type: 'json_schema', name: 'tra_portfolio_audit', strict: true, schema: portfolioAuditSchema(concepts.length) } },
    }),
  });
  if (!response.ok) throw new Error(`Portfolio audit failed (HTTP ${response.status}). No images were generated.`);
  const payload = await response.json() as { status?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const output = Array.isArray(payload?.output)
    ? payload.output.flatMap(item => Array.isArray(item?.content) ? item.content : []).find(item => item?.type === 'output_text')?.text : undefined;
  if (payload?.status !== 'completed' || !output) throw new Error('Portfolio audit did not complete. No images were generated.');
  let audit: PortfolioAudit | null;
  try { audit = parsePortfolioAudit({ ...JSON.parse(output), version: 1, model, conceptCount: concepts.length }); }
  catch { audit = null; }
  if (!audit) throw new Error('Portfolio audit did not cover every concept exactly once. No images were generated.');
  return audit;
}
