import { describe, expect, it } from 'vitest';
import { parseCopilotContextSnapshot, parseCopilotRecommendation } from '@/lib/copilot/records';

const id = `creative_${'a'.repeat(32)}`;
const context = () => ({ company: { reference: 'approved-company:v1', approvedText: 'Approved services, claims and guardrails.' },
  creatives: [{ creativeId: id, identity: { conceptId: id, parentCreativeId: null, operation: 'GENERATE', fingerprint: 'b'.repeat(64) },
    sourceReferences: ['approved-tra-source:1'] }], performance: 'unknown' });
const model = { provider: 'caller-selected-provider', model: 'caller-selected-model' };
const recommendation = () => ({ version: 1, generatedAt: '2026-10-11T12:00:00Z', action: 'PROPOSE_CREATIVE_TEST',
  observations: [{ text: 'The saved creative uses an approved source.', evidenceReferences: [id, 'approved-tra-source:1'] }],
  inferences: [{ text: 'A clearer next-step concept is worth exploring.', evidenceReferences: ['approved-company:v1'] }],
  recommendation: { text: 'Propose a non-human concept explaining the next step.', soWhat: {
    surfaceMessage: 'Know your next step', functionalConsequence: 'Understand the consultation process', meaningfulOutcome: 'Move forward with more confidence' } },
  unknowns: ['Actual performance has not been supplied.'], performance: 'unknown' });

describe('creative-only offline Copilot records', () => {
  it('round-trips explicit context, preserves caller model and distinguishes observations/inferences', () => {
    const result = parseCopilotRecommendation(JSON.parse(JSON.stringify(recommendation())), context(), model);
    expect(result).toMatchObject({ ...recommendation(), model, context: context() });
    expect(result).not.toHaveProperty('tools');
  });
  it('supports company-only context and a do-nothing result without inventing evidence or performance', () => {
    const input = { ...recommendation(), action: 'DO_NOTHING', recommendation: null, observations: [], inferences: [] };
    expect(parseCopilotRecommendation(input, { ...context(), creatives: [] }, model)).toMatchObject({ action: 'DO_NOTHING', recommendation: null, performance: 'unknown' });
  });
  it('copies supplied snapshots so later caller mutation does not rewrite recorded evidence', () => {
    const supplied = context(); const input = recommendation();
    const result = parseCopilotRecommendation(input, supplied, model)!;
    supplied.creatives[0].sourceReferences.push('later-source'); input.observations[0].evidenceReferences.push('later-evidence');
    expect(result.context.creatives[0].sourceReferences).toEqual(['approved-tra-source:1']);
    expect(result.observations[0].evidenceReferences).toEqual([id, 'approved-tra-source:1']);
  });
  it.each([
    ['missing evidence', (v: ReturnType<typeof recommendation>) => ({ ...v, observations: [{ text: 'Claim', evidenceReferences: ['absent-source'] }] })],
    ['unreferenced observation', (v: ReturnType<typeof recommendation>) => ({ ...v, observations: [{ text: 'Claim', evidenceReferences: [] }] })],
    ['unsupported performance', (v: ReturnType<typeof recommendation>) => ({ ...v, performance: 'winning' })],
    ['financial action', (v: ReturnType<typeof recommendation>) => ({ ...v, action: 'SCALE_BUDGET' })],
    ['mutation tools', (v: ReturnType<typeof recommendation>) => ({ ...v, tools: ['publish'] })],
    ['model-authored identity', (v: ReturnType<typeof recommendation>) => ({ ...v, model: { model: 'guessed' } })],
    ['no inference for proposed test', (v: ReturnType<typeof recommendation>) => ({ ...v, inferences: [] })],
    ['empty outcome', (v: ReturnType<typeof recommendation>) => ({ ...v, recommendation: { ...v.recommendation, soWhat: { ...v.recommendation.soWhat, meaningfulOutcome: '' } } })],
    ['repeated outcome chain', (v: ReturnType<typeof recommendation>) => ({ ...v, recommendation: { ...v.recommendation, soWhat: { surfaceMessage: ' Same ', functionalConsequence: 'same', meaningfulOutcome: 'SAME' } } })],
    ['invalid time', (v: ReturnType<typeof recommendation>) => ({ ...v, generatedAt: '2026-02-30T12:00:00Z' })],
    ['malformed unknowns', (v: ReturnType<typeof recommendation>) => ({ ...v, unknowns: [null] })],
    ['do-nothing with proposal', (v: ReturnType<typeof recommendation>) => ({ ...v, action: 'DO_NOTHING' })],
  ])('rejects %s', (_label, mutate) => expect(parseCopilotRecommendation(mutate(recommendation()), context(), model)).toBeNull());
  it('rejects invalid identities, duplicate creatives, absent company approval text and metric injection', () => {
    const input = context();
    expect(parseCopilotContextSnapshot({ ...input, creatives: [input.creatives[0], input.creatives[0]] })).toBeNull();
    expect(parseCopilotContextSnapshot({ ...input, creatives: [{ ...input.creatives[0], identity: {} }] })).toBeNull();
    expect(parseCopilotContextSnapshot({ ...input, company: { ...input.company, approvedText: '' } })).toBeNull();
    expect(parseCopilotContextSnapshot({ ...input, revenue: 100 })).toBeNull();
    expect(parseCopilotRecommendation(recommendation(), input, undefined)).toBeNull();
    expect(parseCopilotRecommendation(recommendation(), input, { ...model, model: '' })).toBeNull();
  });
  it('rejects missing sections and malformed source references before accepting evidence', () => {
    const input = context();
    expect(parseCopilotContextSnapshot({ ...input, creatives: [{ ...input.creatives[0], sourceReferences: [''] }] })).toBeNull();
    expect(parseCopilotContextSnapshot({ ...input, creatives: [{ ...input.creatives[0], sourceReferences: ['same', 'same'] }] })).toBeNull();
    const incomplete: Partial<ReturnType<typeof recommendation>> = recommendation();
    delete incomplete.unknowns;
    expect(parseCopilotRecommendation(incomplete, input, model)).toBeNull();
    expect(parseCopilotRecommendation({ ...recommendation(), observations: 'not an array' }, input, model)).toBeNull();
  });
});
