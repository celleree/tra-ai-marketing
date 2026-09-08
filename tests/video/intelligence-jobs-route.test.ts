import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ execute: vi.fn(), read: vi.fn() }));
const requireOperatorAccess = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess }));
vi.mock('@/lib/video/intelligence-service', async (load) => ({
  ...await load<typeof import('@/lib/video/intelligence-service')>(),
  executeVideoIntelligenceStep: service.execute, readVideoIntelligenceSource: service.read,
}));
import { GET, POST } from '@/app/api/video/intelligence/jobs/route';
import { VideoIntelligenceServiceError } from '@/lib/video/intelligence-service';
import { CreativeSourceHydrationError } from '@/lib/media/source-hydration';

const mediaId = `media_${'a'.repeat(32)}`;
const locator = { version: 1, sourceVideoMediaId: mediaId, sourceVideoContentHash: 'b'.repeat(64), analyzerFingerprintSha256: 'c'.repeat(64) };
const status = { locator, jobId: 'video-intelligence-job:test', phase: 'RETRY_REQUIRED', busy: false,
  completedRepresentatives: 1, totalRepresentatives: 2, updatedAtMs: 1_000 };
const post = (body: unknown) => new Request('http://localhost/api/video/intelligence/jobs', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); requireOperatorAccess.mockResolvedValue(null); vi.stubEnv('NODE_ENV', 'test'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('video job control API', () => {
  it('reopens source metadata and progress without starting analysis', async () => {
    const payload = { source: { id: mediaId, mediaType: 'VIDEO' }, locator, status: null };
    service.read.mockResolvedValue(payload);
    const response = await GET(new Request(`http://localhost/api/video/intelligence/jobs?mediaId=${mediaId}`));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(payload);
    expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(service.execute).not.toHaveBeenCalled();
  });

  it.each(['START', 'STATUS', 'ADVANCE', 'RETRY'])('delegates %s once and returns compact state', async (action) => {
    service.execute.mockResolvedValue(status);
    const input = action === 'START' ? { action, mediaId } : { action, locator };
    const response = await POST(post({ ...input, deadlineAtMs: Number.MAX_SAFE_INTEGER, force: true, leaseId: 'client-value' }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(status);
    expect(service.execute).toHaveBeenCalledTimes(1);
    expect(service.execute.mock.calls[0][0]).toEqual(input);
    expect(service.execute.mock.calls[0][1].deadlineAtMs).not.toBe(Number.MAX_SAFE_INTEGER);
    expect(service.read).not.toHaveBeenCalled();
  });

  it('captures the server deadline before request parsing, preserving time spent on prework', async () => {
    let clock = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const request = post({ action: 'ADVANCE', locator });
    vi.spyOn(request, 'json').mockImplementation(async () => { clock = 100_000; return { action: 'ADVANCE', locator }; });
    service.execute.mockResolvedValue(status);
    await POST(request);
    expect(service.execute.mock.calls[0][1]).toEqual({ deadlineAtMs: 296_000 });
  });

  it.each([null, [], {}, { action: 'LOOP' }, { action: 'START', mediaId: 123 }])('rejects malformed body before service work', async (body) => {
    expect((await POST(post(body))).status).toBe(400); expect(service.execute).not.toHaveBeenCalled();
  });

  it('maps invalid JSON, stale settings, missing source, and storage failures', async () => {
    expect((await POST(new Request('http://localhost/jobs', { method: 'POST', body: '{' }))).status).toBe(400);
    for (const [error, code] of [[new VideoIntelligenceServiceError('Settings changed', 409), 409],
      [new CreativeSourceHydrationError('Source missing', 404), 404], [new Error('Storage unavailable'), 500]] as const) {
      service.execute.mockRejectedValueOnce(error);
      const response = await POST(post({ action: 'ADVANCE', locator }));
      expect(response.status).toBe(code); expect(await response.json()).toEqual({ error: error.message });
    }
  });

  it('retains the production guard before parsing or any service work', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await POST(new Request('http://localhost/jobs', { method: 'POST', body: '{' }))).status).toBe(404);
    expect((await GET(new Request('http://localhost/jobs'))).status).toBe(404);
    expect(service.execute).not.toHaveBeenCalled(); expect(service.read).not.toHaveBeenCalled();
  });
});
