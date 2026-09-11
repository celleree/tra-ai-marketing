import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planCreativeRevision } from '@/lib/ai/creative-revision-planner';
import type { CreativeStrategy } from '@/lib/creatives/strategy';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { referenceCandidate } from '../fixtures/reference-catalog';

const strategy: CreativeStrategy = {
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Busy taxpayer', painPoint: 'Unclear next steps', desiredOutcome: 'A clear plan', emotion: 'Relief', hook: 'Find a path forward', cta: 'Get a consultation', offer: null,
  soWhat: { surfaceMessage: 'Understand the next step', functionalConsequence: 'Organize your options', meaningfulOutcome: 'Move forward with confidence' },
  execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'minimal-graphic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'A clean desk',
};
const parent = { format: 'direct-response' as const, copy: { headline: 'Find a path forward', primaryText: 'Talk with TRA', description: '' }, strategy };
const plan = () => ({ ...parent, strategy: { ...strategy, conceptDetails }, selectionReason: 'Respect the requested edit.' });
const payload = (value: unknown) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const fetchMock = vi.fn();
const args = { parent, operation: 'EDIT' as const, instruction: 'Make the headline blue.', companyContext: 'APPROVED TRA COMPANY CONTEXT\nNo numeric claims approved.', hasApprovedHumanSource: false };

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
  vi.stubEnv('OPENAI_TEXT_MODEL', '');
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify(payload(plan()))));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('single-creative revision planning', () => {
  it('resolves independent revision choices and rejects missing catalog IDs', async () => {
    const referenceCatalog = [referenceCandidate()];
    const referenceChoices = { angleSource: referenceCatalog[0].referenceId, layoutSource: null };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload({ ...plan(), referenceChoices }))));
    expect((await planCreativeRevision({ ...args, referenceCatalog })).concept.strategy.referenceSelection)
      .toEqual({ ...referenceChoices, referenceRelationship: 'mixed' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload({ ...plan(), referenceChoices }))));
    await expect(planCreativeRevision({ ...args, referenceCatalog: [] })).rejects.toThrow('Unavailable');
  });
  it('uses one Astra Medium request and permits an ordinary edit without variation requirements', async () => {
    const result = await planCreativeRevision(args);
    expect(result).toMatchObject({ concept: { ...plan(), index: 1 }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(JSON.parse(body.input[1].content[0].text)).toEqual(args);
    expect(body.input[0].content[0].text).toContain('not evidence that its claims are approved');
    expect(body.input[0].content[0].text).toContain('canvas and layout/reference-library content never confer human approval');
  });

  it('retains configured planner model identity', async () => {
    vi.stubEnv('OPENAI_TEXT_MODEL', 'configured-planner');
    expect((await planCreativeRevision(args)).plannerModel).toBe('configured-planner');
  });

  it('rejects superficial variations and accepts meaningful strategic/execution differences', async () => {
    await expect(planCreativeRevision({ ...args, operation: 'VARIATION' })).rejects.toThrow('too similar');
    const changed = { ...plan(), copy: { ...parent.copy, headline: 'Move beyond the notices' }, strategy: { ...strategy, conceptDetails, awarenessStage: 'solution-aware', soWhat: { ...strategy.soWhat, surfaceMessage: 'Explore a resolution path' }, execution: { ...strategy.execution, composition: 'split', imageTreatment: 'illustrative' } } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(changed))));
    expect((await planCreativeRevision({ ...args, operation: 'VARIATION' })).concept.strategy.awarenessStage).toBe('solution-aware');
  });

  it.each([
    { ...plan(), strategy },
    { ...plan(), extra: true },
    { ...plan(), copy: { ...parent.copy, headline: 'x'.repeat(1001) } },
    { ...plan(), strategy: { ...strategy, execution: { ...strategy.execution, subjectSource: 'approved-tra-human' } } },
    { ...plan(), strategy: { ...strategy, soWhat: null } },
  ])('rejects malformed plans or unavailable human sources %#', async (value) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(value))));
    await expect(planCreativeRevision(args)).rejects.toThrow('invalid revision');
  });

  it('surfaces provider failures, missing output and refusals without inventing a plan', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(planCreativeRevision(args)).rejects.toThrow('HTTP 429');
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    await expect(planCreativeRevision(args)).rejects.toThrow('no revision plan');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ output: [{ content: [{ type: 'refusal', refusal: 'Unavailable' }] }] })));
    await expect(planCreativeRevision(args)).rejects.toThrow('declined');
  });
});
