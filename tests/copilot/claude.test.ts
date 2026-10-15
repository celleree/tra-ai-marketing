import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_COPILOT_MODEL, ClaudeCopilotError, requestClaudeCopilot } from '@/lib/copilot/claude';

const context = () => ({ company: { reference: 'approved:v1', approvedText: 'Approved services and guardrails' }, creatives: [], performance: 'unknown' });
const record = () => ({ version: 1, generatedAt: '2026-10-11T12:00:00Z', action: 'DO_NOTHING',
  observations: [{ text: 'Approved services supplied.', evidenceReferences: ['approved:v1'] }],
  inferences: [], recommendation: null, unknowns: ['Performance and revenue unknown.'], performance: 'unknown' });
const envelope = (value: unknown = record()) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] });
const setup = (value: unknown = envelope()) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
  return { fetchMock, options: { apiKey: 'test-key-never-live', allowPaidRequest: true, maxOutputTokens: 1024, fetch: fetchMock } };
};
afterEach(() => vi.unstubAllEnvs());

describe('bounded Claude creative copilot adapter (offline)', () => {
  it('blocks direct adapter dispatch in acceptance Preview even with existing approval and credentials', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
    const { fetchMock, options } = setup();
    await expect(requestClaudeCopilot(context(), options)).rejects.toMatchObject({ code: 'unavailable', status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([['production', 'staging-smoke'], ['preview', 'diagnostic']])('retains direct adapter behavior for %s / %s', async (environment, purpose) => {
    vi.stubEnv('VERCEL_ENV', environment); vi.stubEnv('TRA_IMAGE_PURPOSE', purpose);
    const { fetchMock, options } = setup();
    await expect(requestClaudeCopilot(context(), options)).resolves.toHaveProperty('action', 'DO_NOTHING');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('sends one capped Messages request with supplied context, no tools and authoritative model/context', async () => {
    const { fetchMock, options } = setup(); const supplied = context();
    const result = await requestClaudeCopilot(supplied, options);
    expect(result).toEqual({ ...record(), context: supplied, model: { provider: 'anthropic', model: CLAUDE_COPILOT_MODEL } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    const body = JSON.parse(request!.body as string);
    expect(body).toMatchObject({ model: CLAUDE_COPILOT_MODEL, max_tokens: 1024, messages: [{ role: 'user', content: JSON.stringify(supplied) }] });
    expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('temperature');
    expect(body.system).toContain('Performance and revenue are unknown');
    supplied.company.approvedText = 'later mutation'; expect(result.context.company.approvedText).toBe('Approved services and guardrails');
  });
  it.each([{ apiKey: undefined }, { apiKey: ' ' }, { allowPaidRequest: false }])('fails closed before fetch for %j', async (override) => {
    const { fetchMock, options } = setup();
    await expect(requestClaudeCopilot(context(), { ...options, ...override })).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([0, -1, 4097, 1.5, NaN])('rejects output token cap %s before fetch', async (maxOutputTokens) => {
    const { fetchMock, options } = setup();
    await expect(requestClaudeCopilot(context(), { ...options, maxOutputTokens })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects invalid context and bounds UTF-8 input before fetch', async () => {
    const { fetchMock, options } = setup();
    await expect(requestClaudeCopilot({ ...context(), performance: 'winner' }, options)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(requestClaudeCopilot({ ...context(), company: { reference: 'approved:v1', approvedText: '界'.repeat(25000) } }, options)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('supports adaptive thinking blocks and proposed creative tests', async () => {
    const proposal = { ...record(), action: 'PROPOSE_CREATIVE_TEST', inferences: [{ text: 'A next-step concept may clarify services.', evidenceReferences: ['approved:v1'] }],
      recommendation: { text: 'Explore consultation steps.', soWhat: { surfaceMessage: 'Know the next step', functionalConsequence: 'Understand consultation', meaningfulOutcome: 'Proceed with confidence' } } };
    const value = envelope(proposal); value.content.unshift({ type: 'thinking', text: 'ignored reasoning' });
    const { options } = setup(value);
    expect(await requestClaudeCopilot(context(), options)).toMatchObject(proposal);
  });
  it.each(['max_tokens', 'refusal', 'tool_use', 'pause_turn'])('rejects %s without retry', async (stop_reason) => {
    const { fetchMock, options } = setup({ ...envelope(), stop_reason });
    await expect(requestClaudeCopilot(context(), options)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '```json invalid```' }] },
    envelope({ ...record(), observations: [{ text: 'Invented evidence', evidenceReferences: ['unknown'] }] }),
    envelope({ ...record(), model: { provider: 'fake', model: 'fake' } }),
    envelope({ ...record(), action: 'PUBLISH' }),
    { stop_reason: 'end_turn', content: [{ type: 'refusal', refusal: 'cannot comply' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(64001) }] },
    { stop_reason: 'end_turn', content: [] },
  ])('rejects malformed/unsupported output without retry', async (value) => {
    const { fetchMock, options } = setup(value);
    await expect(requestClaudeCopilot(context(), options)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('redacts provider and network failures and never retries', async () => {
    const { fetchMock, options } = setup();
    fetchMock.mockResolvedValueOnce(new Response('secret test-key-never-live provider body', { status: 429 }));
    await expect(requestClaudeCopilot(context(), options)).rejects.toEqual(new ClaudeCopilotError('provider_error', 429));
    fetchMock.mockRejectedValueOnce(new Error('secret test-key-never-live network detail'));
    await expect(requestClaudeCopilot(context(), options)).rejects.toEqual(new ClaudeCopilotError('provider_error'));
    fetchMock.mockResolvedValueOnce(new Response('not json secret'));
    await expect(requestClaudeCopilot(context(), options)).rejects.toEqual(new ClaudeCopilotError('provider_error'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('does not fetch with pre-aborted signal and aborts a single timed-out request', async () => {
    const { fetchMock, options } = setup();
    await expect(requestClaudeCopilot(context(), { ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('sensitive abort detail')), { once: true });
    }));
    await expect(requestClaudeCopilot(context(), { ...options, timeoutMs: 10 })).rejects.toMatchObject({ code: 'aborted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
