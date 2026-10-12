import { describe, expect, it, vi } from 'vitest';
import { readMotionControlJob, submitMotionControl } from '@/lib/video-generation/higgsfield';

const id = 'd7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff';
const queued = { request_id: id, status: 'queued', status_url: `https://api.higgsfield.ai/requests/${id}/status` };
const input = { imageUrl: 'https://media.example/image.png?signature=private', motionVideoUrl: 'https://media.example/motion.mp4',
  prompt: 'Natural motion', characterOrientation: 'video' as const, keepOriginalSound: false };
const admission = { authorizationReference: 'approved-budget:1', permissionReference: 'licensed-inputs:1',
  quoteReference: 'approved-provider-quote:1', quotedCostUsd: 0.35, maxCostUsd: 0.5, idempotencyKey: 'owned-request-1' };
const transport = (value: unknown = queued) => ({ keyId: 'test-id', keySecret: 'test-secret',
  fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(value)) });

describe('Higgsfield Kling 2.6 Standard server transport', () => {
  it('submits exact selected model, explicit sound choice and stable idempotency key once', async () => {
    const options = transport(); const job = await submitMotionControl(input, admission, options);
    const [url, request] = options.fetch.mock.calls[0];
    expect(url).toBe('https://api.higgsfield.ai/kling-video/motion-control/std');
    expect(request?.headers).toEqual({ Authorization: 'Key test-id:test-secret', 'Content-Type': 'application/json', 'Idempotency-Key': admission.idempotencyKey });
    expect(JSON.parse(request?.body as string)).toEqual({ image_url: input.imageUrl, video_url: input.motionVideoUrl,
      prompt: input.prompt, character_orientation: 'video', keep_original_sound: 'no' });
    expect(request?.redirect).toBe('error'); expect(options.fetch).toHaveBeenCalledTimes(1);
    expect(job).toEqual({ requestId: id, status: 'queued', statusUrl: queued.status_url, videoUrl: null });
  });
  it('polls the accepted job without another paid submission and preserves completed output', async () => {
    const options = transport(); const job = await submitMotionControl(input, admission, options);
    options.fetch.mockResolvedValueOnce(Response.json({ request_id: id, status: 'completed', video: { url: 'https://cdn.example/output.mp4' } }));
    expect((await readMotionControlJob(job, options)).videoUrl).toBe('https://cdn.example/output.mp4');
    expect(options.fetch.mock.calls[1][1]?.method).toBe('GET');
  });
  it.each(['failed', 'nsfw', 'canceled'])('returns terminal %s without output or leaking provider errors', async status => {
    const options = transport({ request_id: id, status, error: 'test-secret private' });
    expect(await submitMotionControl(input, admission, options)).toEqual({ requestId: id, status, statusUrl: null, videoUrl: null });
  });
  it.each(['authorizationReference', 'permissionReference', 'quoteReference', 'idempotencyKey'])('fails missing %s before any request', async field => {
    const options = transport();
    await expect(submitMotionControl(input, { ...admission, [field]: '' }, options)).rejects.toThrow('invalid_input');
    expect(options.fetch).not.toHaveBeenCalled();
  });
  it('refuses quote above approval, non-HTTPS input and missing credentials', async () => {
    const options = transport();
    await expect(submitMotionControl(input, { ...admission, quotedCostUsd: 1 }, options)).rejects.toThrow('invalid_input');
    await expect(submitMotionControl({ ...input, imageUrl: 'http://media.example/input' }, admission, options)).rejects.toThrow('invalid_input');
    await expect(submitMotionControl(input, admission, { ...options, keySecret: '' })).rejects.toThrow('missing_credentials');
    expect(options.fetch).not.toHaveBeenCalled();
  });
  it.each(['has space', 'unicode-\u00e9', 'a'.repeat(256)])('rejects unsupported idempotency keys before paid work', async idempotencyKey => {
    const options = transport();
    await expect(submitMotionControl(input, { ...admission, idempotencyKey }, options)).rejects.toThrow('invalid_input');
    expect(options.fetch).not.toHaveBeenCalled();
  });
  it('does not retry ambiguous submission failures or expose transport secrets', async () => {
    const options = transport(); options.fetch.mockRejectedValueOnce(new Error('test-secret signature=private'));
    await expect(submitMotionControl(input, admission, options)).rejects.toThrow('Higgsfield ambiguous_submission.');
    expect(options.fetch).toHaveBeenCalledTimes(1);
  });
  it('blocks browser execution and pre-aborted submissions before fetch', async () => {
    const options = transport();
    vi.stubGlobal('window', {});
    try { await expect(submitMotionControl(input, admission, options)).rejects.toThrow('missing_credentials'); }
    finally { vi.unstubAllGlobals(); }
    await expect(submitMotionControl(input, admission, { ...options, signal: AbortSignal.abort() })).rejects.toThrow('transport_error');
    expect(options.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 422, 500])('redacts HTTP%s errors without retries', async status => {
    const options = transport(); options.fetch.mockResolvedValueOnce(new Response('test-secret', { status }));
    await expect(submitMotionControl(input, admission, options)).rejects.toThrow(status >= 500 ? 'ambiguous_submission' : 'http_error');
    expect(options.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...queued, status: 'unknown' }, { ...queued, status: ['queued'] },
    { ...queued, status_url: 'https://other.example/status' },
    { ...queued, status_url: `${queued.status_url}?signed=private` },
    { request_id: id, status: 'completed', video: null },
  ])('rejects malformed provider state', async value => {
    await expect(submitMotionControl(input, admission, transport(value))).rejects.toThrow('invalid_response');
  });
  it('rejects changed request identity and never sends credentials to an arbitrary polling origin', async () => {
    const options = transport(); const job = await submitMotionControl(input, admission, options);
    await expect(readMotionControlJob({ ...job, statusUrl: 'https://other.example/status' }, options)).rejects.toThrow('invalid_input');
    expect(options.fetch).toHaveBeenCalledTimes(1);
    options.fetch.mockResolvedValueOnce(Response.json({ ...queued, request_id: '11111111-1111-1111-1111-111111111111' }));
    await expect(readMotionControlJob(job, options)).rejects.toThrow('invalid_response');
  });
});
