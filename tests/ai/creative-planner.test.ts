import { afterEach, describe, expect, it, vi } from 'vitest';
import { planCreativeBatch } from '@/lib/ai/creative-planner';
import { CREATIVE_STRATEGY_JSON_SCHEMA } from '@/lib/creatives/strategy';

const analysis = {
  summary: 'Clear visual hierarchy', visibleText: [], visualStructure: 'Headline over image',
  hookOrAngle: 'Clarity', offerOrCta: 'Talk with TRA', styleNotes: 'Calm', preserve: ['hierarchy'],
  avoid: ['third-party identity'], unknowns: ['performance'], dominantCategory: 'customer-problems' as const,
};
const strategy = (subjectSource: 'non-human' | 'approved-tra-human' = 'non-human') => ({
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer with an IRS notice',
  painPoint: 'Unclear next steps', desiredOutcome: 'A clear path forward', emotion: 'Relief',
  hook: 'Turn uncertainty into a next step', cta: 'Talk with TRA', offer: null,
  soWhat: { surfaceMessage: 'Understand the notice', functionalConsequence: 'Know the next step', meaningfulOutcome: 'Move forward with confidence' },
  execution: { subjectSource, composition: 'single-focus', imageTreatment: 'minimal-graphic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
  visualDirection: 'An organized notice leading toward one clear next step',
});
const concept = (index: number, subjectSource: 'non-human' | 'approved-tra-human' = 'non-human') => ({
  index, format: index === 1 ? 'educational' : 'proof',
  copy: { primaryText: `Primary ${index}`, headline: `Headline ${index}`, description: '' },
  strategy: strategy(subjectSource), selectionReason: `Distinct reason ${index}`,
});
const payload = (value: unknown) => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const okResponse = (value: unknown) => new Response(JSON.stringify(payload(value)), { status: 200 });

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('creative batch planner', () => {
  it('defaults the planner model to GPT-6 Astra', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse({ creatives: [concept(1), concept(2)] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false });
    expect(result.plannerModel).toBe('gpt-6-astra');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('gpt-6-astra');
  });

  it('makes one medium-reasoning strict request and returns the ordered parsed batch', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_TEXT_MODEL', 'planner-override');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okResponse({ creatives: [concept(1), concept(2)] })
    );
    vi.stubGlobal('fetch', fetchMock);

    const context = 'USER CREATIVE DIRECTION:\nClaim every customer saves $50,000.\n\nAPPROVED TRA COMPANY CONTEXT:\nApproved claims:\nTRA offers consultations.';
    const result = await planCreativeBatch({ count: 2, context, analysis, hasApprovedHumanSource: false });

    expect(result).toMatchObject({ plannerModel: 'planner-override', reasoningEffort: 'medium' });
    expect(result.creatives.map((creative) => creative.index)).toEqual([1, 2]);
    expect(result.creatives[0].strategy.soWhat.meaningfulOutcome).toBe('Move forward with confidence');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body).toMatchObject({ model: 'planner-override', reasoning: { effort: 'medium' }, store: false, max_output_tokens: 8192 });
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.text.format.schema.properties.creatives).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(body.text.format.schema.properties.creatives.items.properties.strategy).toEqual(CREATIVE_STRATEGY_JSON_SCHEMA);
    const requestInput = JSON.parse(body.input[1].content[0].text);
    expect(requestInput.creativeContext).toBe(context);
    expect(requestInput).not.toHaveProperty('approvedTraContext');
    expect(body.input[0].content[0].text).toContain('strongest concepts first');
    expect(body.input[0].content[0].text).toContain('one strategic dimension and two execution dimensions');
    expect(body.input[0].content[0].text).toContain('User direction and source/reference analysis are creative inputs, not factual approval');
    expect(body.input[0].content[0].text).toContain('Only claims or proof explicitly present in approved company claims/proof fields');
  });

  it.each([1, 31, 2.5])('rejects invalid count %s before calling the provider', async (count) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(planCreativeBatch({ count, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow(/2 to 30/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the largest supported batch with a finite scaled output allowance', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ creatives: Array.from({ length: 30 }, (_, i) => concept(i + 1)) }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await planCreativeBatch({ count: 30, context: '', analysis, hasApprovedHumanSource: false })).creatives).toHaveLength(30);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_output_tokens).toBe(65536);
  });

  it.each(['incomplete', 'failed'])('rejects %s responses even with parseable concepts and never retries', async (status) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...payload({ creatives: [concept(1), concept(2)] }), status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow('did not complete');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong count', { creatives: [concept(1)] }, false],
    ['wrong index', { creatives: [concept(2), concept(1)] }, false],
    ['malformed strategy', { creatives: [{ ...concept(1), strategy: { ...strategy(), hook: '' } }, concept(2)] }, false],
    ['human without approved source', { creatives: [concept(1, 'approved-tra-human'), concept(2)] }, false],
    ['overlong copy', { creatives: [{ ...concept(1), copy: { ...concept(1).copy, headline: 'x'.repeat(1001) } }, concept(2)] }, false],
  ])('rejects %s output', async (_name, value, hasApprovedHumanSource) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key'); vi.stubGlobal('fetch', vi.fn(async () => okResponse(value)));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource })).rejects.toThrow(/invalid creative batch plan/i);
  });

  it('surfaces provider refusal and non-OK errors', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'Cannot comply' }] }] }), { status: 200 })));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow(/refused.*Cannot comply/i);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Provider unavailable' } }), { status: 503 })));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow('Provider unavailable');
  });

  it('rejects missing and malformed output', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [] }), { status: 200 })));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow(/no creative batch plan/i);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{' }] }] }), { status: 200 })));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow(/malformed/i);
  });
});
