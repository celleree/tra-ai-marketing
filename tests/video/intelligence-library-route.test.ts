import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), load: vi.fn() }));
vi.mock('@/lib/video/intelligence-service', async (load) => ({
  ...await load<typeof import('@/lib/video/intelligence-service')>(), resolveExistingVideoIntelligenceJob: mocks.resolve,
}));
vi.mock('@/lib/video/intelligence-finalization-runner', async (load) => ({
  ...await load<typeof import('@/lib/video/intelligence-finalization-runner')>(), loadVideoIntelligenceLibrary: mocks.load,
}));
import { POST } from '@/app/api/video/intelligence/library/route';
import { VideoIntelligenceServiceError } from '@/lib/video/intelligence-service';

const locator = { version: 1, sourceVideoMediaId: `media_${'a'.repeat(32)}`, sourceVideoContentHash: 'b'.repeat(64), analyzerFingerprintSha256: 'c'.repeat(64) };
const identity = { sourceVideoMediaId: locator.sourceVideoMediaId };
const artifact = { key: 'private-library-artifact', sha256: 'd'.repeat(64), byteLength: 20 };
const request = () => new Request('http://localhost/api/video/intelligence/library', { method: 'POST', body: JSON.stringify({ locator }) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); });
afterEach(() => vi.unstubAllEnvs());

describe('completed video library delivery', () => {
  it('streams only the validated library in bounded chunks, including payloads above 4.5 MB', async () => {
    mocks.resolve.mockResolvedValue({ identity, job: { phase: 'COMPLETE', result: artifact, lease: null } });
    const library = { id: 'video-library:test', thumbnailData: 'x'.repeat(5 * 1024 * 1024) };
    mocks.load.mockResolvedValue(library);
    const response = await POST(request());
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.resolve).toHaveBeenCalledWith(locator, {}); expect(mocks.load).toHaveBeenCalledWith(identity, artifact);
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read(); if (next.done) break;
      expect(next.value.length).toBeLessThanOrEqual(64 * 1024); chunks.push(next.value);
    }
    expect(chunks.length).toBeGreaterThan(1);
    const body = Buffer.concat(chunks).toString('utf8');
    expect(JSON.parse(body)).toEqual(library); expect(body).not.toContain(artifact.key);
  });

  it('rejects incomplete jobs before loading artifacts', async () => {
    mocks.resolve.mockResolvedValue({ identity, job: { phase: 'OBSERVING' } });
    expect((await POST(request())).status).toBe(409); expect(mocks.load).not.toHaveBeenCalled();
  });

  it('fails before streaming on missing/stale jobs or artifact integrity failure', async () => {
    mocks.resolve.mockRejectedValueOnce(new VideoIntelligenceServiceError('Missing job', 404));
    expect((await POST(request())).status).toBe(404);
    mocks.resolve.mockRejectedValueOnce(new VideoIntelligenceServiceError('Settings changed', 409));
    expect((await POST(request())).status).toBe(409);
    mocks.resolve.mockResolvedValue({ identity, job: { phase: 'COMPLETE', result: artifact } });
    mocks.load.mockRejectedValue(new Error('Artifact digest mismatch'));
    const corrupt = await POST(request());
    expect(corrupt.status).toBe(500); expect(await corrupt.json()).toEqual({ error: 'Artifact digest mismatch' });
  });

  it('rejects invalid JSON and production access before loading private data', async () => {
    const malformed = () => new Request('http://localhost/library', { method: 'POST', body: '{' });
    expect((await POST(malformed())).status).toBe(400);
    vi.stubEnv('NODE_ENV', 'production'); expect((await POST(malformed())).status).toBe(404);
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
});
