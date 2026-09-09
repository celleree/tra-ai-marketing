import { afterEach, describe, expect, it, vi } from 'vitest';
import { readVideoIntelligence, runVideoIntelligence, selectVideoIntelligenceFrames } from '@/lib/video/intelligence-client';
import type { CompactVideoIntelligenceJobStatus } from '@/lib/video/intelligence-service';

const locator = { version: 1 as const, sourceVideoMediaId: `media_${'a'.repeat(32)}`,
  sourceVideoContentHash: 'b'.repeat(64), analyzerFingerprintSha256: 'c'.repeat(64) };
const status = (phase: CompactVideoIntelligenceJobStatus['phase'], busy = false): CompactVideoIntelligenceJobStatus => ({
  locator, phase, busy, jobId: 'job', completedRepresentatives: 0, totalRepresentatives: null, updatedAtMs: 1,
});
const setup = (...responses: unknown[]) => {
  const controller = new AbortController();
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(responses.shift()));
  return { controller, request, signal: controller.signal, onStatus: vi.fn() };
};
const actions = (request: ReturnType<typeof vi.fn<typeof fetch>>) => request.mock.calls
  .filter(([url]) => url === '/api/video/intelligence/jobs').map(([, init]) => JSON.parse(init!.body as string).action);
afterEach(() => vi.useRealTimers());

describe('resumable video intelligence client', () => {
  it.each([null, status('OBSERVING'), status('RETRY_REQUIRED')])('reopens incomplete saved work without starting it', async (saved) => {
    const options = setup({ source: { id: locator.sourceVideoMediaId }, locator, status: saved });
    expect(await readVideoIntelligence(locator.sourceVideoMediaId, options)).toMatchObject({ status: saved, library: null });
    expect(options.request).toHaveBeenCalledTimes(1);
    expect(options.request.mock.calls[0][1]).toEqual({ signal: options.signal, cache: 'no-store' });
  });

  it('loads a completed library separately without provider work', async () => {
    const options = setup({ source: { id: locator.sourceVideoMediaId }, locator, status: status('COMPLETE') }, { id: 'saved-library' });
    expect(await readVideoIntelligence(locator.sourceVideoMediaId, options)).toMatchObject({ library: { id: 'saved-library' } });
    expect(options.request.mock.calls.map(([url]) => url)).toEqual([
      `/api/video/intelligence/jobs?mediaId=${locator.sourceVideoMediaId}`, '/api/video/intelligence/library',
    ]);
    expect(JSON.parse(options.request.mock.calls[1][1]!.body as string)).toEqual({ locator });
  });

  it('advances one unit at a time, polls busy status, then reads the completed library', async () => {
    vi.useFakeTimers();
    const options = setup(status('TRANSCRIBING'), status('OBSERVING', true), status('OBSERVING'), status('COMPLETE'), { id: 'library' });
    const result = runVideoIntelligence({ action: 'START', mediaId: locator.sourceVideoMediaId }, options);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(actions(options.request)).toEqual(['START', 'ADVANCE']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: { phase: 'COMPLETE' }, library: { id: 'library' } });
    expect(actions(options.request)).toEqual(['START', 'ADVANCE', 'STATUS', 'ADVANCE']);
    expect(options.onStatus).toHaveBeenCalledTimes(4);
  });

  it.each(['FAILED', 'RETRY_REQUIRED'] as const)('stops at %s without a retry', async (phase) => {
    const options = setup(status(phase));
    expect(await runVideoIntelligence({ action: 'ADVANCE', locator }, options)).toMatchObject({ status: { phase }, library: null });
    expect(actions(options.request)).toEqual(['ADVANCE']);
  });

  it('sends explicit retry once and stops if it still requires retry', async () => {
    const options = setup(status('RETRY_REQUIRED'));
    await runVideoIntelligence({ action: 'RETRY', locator }, options);
    expect(actions(options.request)).toEqual(['RETRY']);
  });

  it('does not replay a failed or uncertain request', async () => {
    for (const failure of [new Error('connection lost'), Response.json({ error: 'Unavailable' }, { status: 503 })]) {
      const options = setup();
      options.request.mockImplementation(async () => { if (failure instanceof Error) throw failure; return failure; });
      await expect(runVideoIntelligence({ action: 'ADVANCE', locator }, options)).rejects.toThrow();
      expect(options.request).toHaveBeenCalledTimes(1);
    }
  });

  it('stops busy polling when the view is aborted', async () => {
    vi.useFakeTimers();
    const options = setup(status('OBSERVING', true));
    const result = runVideoIntelligence({ action: 'ADVANCE', locator }, options);
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    options.controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(options.request).toHaveBeenCalledTimes(1);
  });

  it('does not issue the next unit after cancellation during a request', async () => {
    const options = setup();
    options.request.mockImplementation(async () => { options.controller.abort(); return Response.json(status('OBSERVING')); });
    await expect(runVideoIntelligence({ action: 'ADVANCE', locator }, options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(options.request).toHaveBeenCalledTimes(1);
    expect(options.onStatus).not.toHaveBeenCalled();
  });

  it.each(['BUSY', 'RETRY_REQUIRED', 'COMPLETE'])('returns selection %s after one cache-aware request', async (selectionStatus) => {
    const options = setup({ status: selectionStatus });
    expect(await selectVideoIntelligenceFrames(locator, '  proof  ', false, options)).toEqual({ status: selectionStatus });
    expect(options.request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(options.request.mock.calls[0][1]!.body as string)).toEqual({ locator, concept: 'proof', retry: false });
  });
});
