import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { selectVideoFramesWithCache } from '@/lib/video/selection-cache';

const library = { id: 'library', sourceVideoMediaId: 'media-video', sourceVideoContentHash: 'b'.repeat(64),
  representativeFrames: [{ id: 'frame-a', timestampMs: 100, qualityScore: 1,
    observation: { sceneType: 'OTHER', topics: ['other'], summary: 'Frame', visibleText: [] }, transcriptSegments: [] }],
} as unknown as VideoFrameLibrary;
const artifactSha = 'a'.repeat(64);
const response = () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text',
  text: JSON.stringify({ frames: [{ frameId: 'frame-a', reason: 'Visible scene.' }] }) }] }] });
class MemoryStorage implements VideoIntelligenceStorage {
  values = new Map<string, { bytes: Buffer; etag: string }>(); counter = 0; failCompletion = false;
  async read(key: string) { const item = this.values.get(key); return item ? { bytes: Buffer.from(item.bytes), etag: item.etag } : null; }
  async write(key: string, bytes: Buffer, expected: string | null) {
    const current = this.values.get(key);
    if (expected === null ? current : current?.etag !== expected) return false;
    if (this.failCompletion && JSON.parse(bytes.toString()).status === 'COMPLETE') throw new Error('storage unavailable');
    this.values.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++this.counter}` }); return true;
  }
}
const setup = () => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const clock = { value: 1_000 }; const storage = new MemoryStorage();
  const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
  const deps = { storage, model: 'frozen-selector', now: () => clock.value, deadlineAtMs: 301_000, request };
  return { clock, storage, request, deps };
};
afterEach(() => vi.unstubAllEnvs());

describe('video selection cache', () => {
  it('reuses completed normalized concepts but isolates library digests and frozen models', async () => {
    const state = setup();
    const first = await selectVideoFramesWithCache(library, artifactSha, '  concept  ', state.deps);
    expect(first).toMatchObject({ status: 'COMPLETE', selection: { concept: 'concept', providerEligible: false, frames: [{ frameId: 'frame-a' }] } });
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).toEqual(first);
    expect(state.request).toHaveBeenCalledTimes(1);
    await selectVideoFramesWithCache(library, 'c'.repeat(64), 'concept', state.deps);
    await selectVideoFramesWithCache(library, artifactSha, 'concept', { ...state.deps, model: 'other-model' });
    expect(state.request).toHaveBeenCalledTimes(3);
    expect(state.request.mock.calls.map((call) => JSON.parse(call[1]!.body as string).model)).toEqual(['frozen-selector', 'frozen-selector', 'other-model']);
  });

  it('lets only one concurrent owner call the provider', async () => {
    const state = setup(); let finish!: (response: Response) => void; let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    state.request.mockImplementationOnce(() => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); });
    const owner = selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps);
    await began;
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).toEqual({ status: 'BUSY' });
    finish(response()); expect(await owner).toMatchObject({ status: 'COMPLETE' });
    expect(state.request).toHaveBeenCalledTimes(1);
  });

  it('requires explicit retry after provider failure or insufficient entry deadline budget', async () => {
    const state = setup(); state.request.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).toEqual({ status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' });
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).toMatchObject({ status: 'RETRY_REQUIRED' });
    expect(state.request).toHaveBeenCalledTimes(1);
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', { ...state.deps, retry: true })).toMatchObject({ status: 'COMPLETE' });
    const short = setup();
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', { ...short.deps, deadlineAtMs: 185_999 }))
      .toEqual({ status: 'RETRY_REQUIRED', reason: 'INSUFFICIENT_TIME' });
    expect(short.request).not.toHaveBeenCalled();
  });

  it('rejects late completion after an expired lease is explicitly replaced', async () => {
    const state = setup(); let finish!: (response: Response) => void; let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    state.request.mockImplementationOnce(() => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); });
    const first = selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps); await began;
    state.clock.value = 301_000;
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).toEqual({ status: 'RETRY_REQUIRED', reason: 'LEASE_EXPIRED' });
    expect(state.request).toHaveBeenCalledTimes(1);
    const replacement = await selectVideoFramesWithCache(library, artifactSha, 'concept', { ...state.deps, retry: true, deadlineAtMs: 601_000 });
    const rejected = expect(first).rejects.toThrow('lease is no longer current'); finish(response()); await rejected;
    expect(replacement).toMatchObject({ status: 'COMPLETE' }); expect(state.request).toHaveBeenCalledTimes(2);
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).toEqual(replacement);
  });

  it('propagates a post-paid checkpoint failure without automatically repeating provider work', async () => {
    const state = setup(); state.storage.failCompletion = true;
    await expect(selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).rejects.toThrow('storage unavailable');
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).toEqual({ status: 'BUSY' });
    state.clock.value = 301_000;
    expect(await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).toEqual({ status: 'RETRY_REQUIRED', reason: 'LEASE_EXPIRED' });
    expect(state.request).toHaveBeenCalledTimes(1);
  });

  it('rejects corrupt cached selection identity or eligibility without paid fallback', async () => {
    const state = setup(); await selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps);
    const stored = [...state.storage.values.values()][0]; const value = JSON.parse(stored.bytes.toString());
    value.selection.providerEligible = true; stored.bytes = Buffer.from(JSON.stringify(value));
    await expect(selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).rejects.toThrow('invalid selection');
    value.selection.providerEligible = false; value.selection.sourceVideoContentHash = 'd'.repeat(64); stored.bytes = Buffer.from(JSON.stringify(value));
    await expect(selectVideoFramesWithCache(library, artifactSha, 'concept', state.deps)).rejects.toThrow('invalid selection');
    expect(state.request).toHaveBeenCalledTimes(1);
  });
});
