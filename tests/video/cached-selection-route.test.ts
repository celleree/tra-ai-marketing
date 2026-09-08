import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), load: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/video/intelligence-service', async (load) => ({
  ...await load<typeof import('@/lib/video/intelligence-service')>(), resolveExistingVideoIntelligenceJob: mocks.resolve,
}));
vi.mock('@/lib/video/intelligence-finalization-runner', () => ({ loadVideoIntelligenceLibrary: mocks.load }));
vi.mock('@/lib/video/selection-cache', () => ({ selectVideoFramesWithCache: mocks.select }));
import { POST } from '@/app/api/video/intelligence/selection/route';
import { VideoIntelligenceServiceError } from '@/lib/video/intelligence-service';

const locator = { version: 1, sourceVideoMediaId: `media_${'a'.repeat(32)}`, sourceVideoContentHash: 'b'.repeat(64), analyzerFingerprintSha256: 'c'.repeat(64) };
const identity = { analyzerFingerprint: { visionModel: 'frozen-selector' } };
const artifact = { key: 'private-library', sha256: 'd'.repeat(64), byteLength: 20 };
const library = { id: 'library' };
const post = (body: unknown) => new Request('http://localhost/api/video/intelligence/selection', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('uses only server-resolved library digest/model and the request-entry deadline', async () => {
  let clock = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => clock);
  mocks.resolve.mockImplementation(async () => { clock = 99_000; return { identity, job: { phase: 'COMPLETE', result: artifact } }; });
  mocks.load.mockResolvedValue(library); mocks.select.mockResolvedValue({ status: 'BUSY' });
  const response = await POST(post({ locator, concept: 'concept', retry: true, model: 'untrusted-model', deadlineAtMs: 999999999, librarySha256: 'ignored' }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: 'BUSY' });
  expect(mocks.load).toHaveBeenCalledWith(identity, artifact);
  expect(mocks.select).toHaveBeenCalledWith(library, artifact.sha256, 'concept', { model: 'frozen-selector', deadlineAtMs: 296_000, retry: true });
});

it.each([null, [], { concept: '' }, { concept: 'a'.repeat(2001) }, { concept: 'valid', retry: 'yes' }])('rejects invalid input before private reads', async (body) => {
  expect((await POST(post(body))).status).toBe(400); expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
});

it('requires a complete validated library before selection and maps stale locator errors', async () => {
  mocks.resolve.mockResolvedValueOnce({ identity, job: { phase: 'OBSERVING' } });
  expect((await POST(post({ locator, concept: 'concept' }))).status).toBe(409); expect(mocks.load).not.toHaveBeenCalled();
  mocks.resolve.mockRejectedValueOnce(new VideoIntelligenceServiceError('Settings changed', 409));
  expect((await POST(post({ locator, concept: 'concept' }))).status).toBe(409); expect(mocks.select).not.toHaveBeenCalled();
});

it('preserves the production guard before parsing or any paid/private work', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect((await POST(new Request('http://localhost/selection', { method: 'POST', body: '{' }))).status).toBe(404);
  expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
});
