import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), quota: vi.fn(), execute: vi.fn(), read: vi.fn(), resolve: vi.fn(),
  load: vi.fn(), select: vi.fn(), storage: vi.fn(), hydrate: vi.fn(), extract: vi.fn(), context: vi.fn(),
}));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.quota }));
vi.mock('@/lib/video/intelligence-service', async load => ({
  ...await load<typeof import('@/lib/video/intelligence-service')>(),
  executeVideoIntelligenceStep: mocks.execute, readVideoIntelligenceSource: mocks.read,
  resolveExistingVideoIntelligenceJob: mocks.resolve,
}));
vi.mock('@/lib/video/intelligence-finalization-runner', () => ({ loadVideoIntelligenceLibrary: mocks.load }));
vi.mock('@/lib/video/selection-cache', () => ({ selectVideoFramesWithCache: mocks.select }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: mocks.storage }));
vi.mock('@/lib/media/source-hydration', async load => ({
  ...await load<typeof import('@/lib/media/source-hydration')>(), hydrateCreativeSourceSelections: mocks.hydrate,
}));
vi.mock('@/lib/video/library-service', () => ({ videoSourceHash: () => 'b'.repeat(64) }));
vi.mock('@/lib/video/selection-context', () => ({ loadVideoSelectionContext: mocks.context, extractVideoSelectionFrames: mocks.extract }));

import { createCurrentVideoIntelligenceIdentity } from '@/lib/video/intelligence-service';
import { GET, POST as job } from '@/app/api/video/intelligence/jobs/route';
import { POST as selection } from '@/app/api/video/intelligence/selection/route';
import { POST as preview } from '@/app/api/video/intelligence/selected-frame-preview/route';

const mediaId = `media_${'a'.repeat(32)}`;
const frameId = `video-frame:${'c'.repeat(64)}`;
const libraryId = `video-library:${'d'.repeat(64)}`;
const identity = () => createCurrentVideoIntelligenceIdentity(mediaId, 'b'.repeat(64));
const locator = () => ({ version: 1, sourceVideoMediaId: mediaId, sourceVideoContentHash: 'b'.repeat(64),
  analyzerFingerprintSha256: identity().analyzerFingerprint.sha256 });
const frameRequest = { mediaId, videoFrameSelection: { libraryId, sourceVideoContentHash: 'b'.repeat(64), frameIds: [frameId] } };
const request = (body: unknown) => new Request('http://localhost/api/video', { method: 'POST', body: JSON.stringify(body) });
const cases = [
  { name: 'START', route: job, body: () => ({ action: 'START', mediaId }), group: 'VIDEO_PREPARATION', first: mocks.execute },
  { name: 'ADVANCE', route: job, body: () => ({ action: 'ADVANCE', locator: locator() }), group: 'VIDEO_PROVIDER_WORK', first: mocks.execute },
  { name: 'RETRY', route: job, body: () => ({ action: 'RETRY', locator: locator() }), group: 'VIDEO_PROVIDER_WORK', first: mocks.execute },
  { name: 'selection', route: selection, body: () => ({ locator: locator(), concept: 'Consultation' }), group: 'VIDEO_SELECTION', first: mocks.resolve },
  { name: 'preview', route: preview, body: () => frameRequest, group: 'VIDEO_FRAME_PREVIEW', first: mocks.storage },
];
const expectNoWork = () => {
  for (const fn of [mocks.execute, mocks.read, mocks.resolve, mocks.load, mocks.select, mocks.storage, mocks.hydrate, mocks.extract]) {
    expect(fn).not.toHaveBeenCalled();
  }
  expect(fetch).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('TRA_PRODUCTION_VIDEO_ENABLED', '0');
  vi.stubGlobal('fetch', vi.fn());
  mocks.access.mockResolvedValue({ allowed: true, userId: 'operator' }); mocks.quota.mockResolvedValue(null);
  mocks.execute.mockResolvedValue({ phase: 'COMPLETE' }); mocks.read.mockResolvedValue({ status: null });
  mocks.resolve.mockResolvedValue({ identity: identity(), job: { phase: 'COMPLETE', result: { sha256: 'e'.repeat(64) } } });
  mocks.load.mockResolvedValue({ id: libraryId }); mocks.select.mockResolvedValue({ status: 'BUSY' });
  mocks.storage.mockReturnValue({}); mocks.hydrate.mockResolvedValue([{ role: 'TRA_VIDEO' }]);
  mocks.context.mockResolvedValue({ library: { id: libraryId } });
  mocks.extract.mockResolvedValue({ frames: [{ buffer: Buffer.from('png'), timestampMs: 500, frameSha256: 'f'.repeat(64) }] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(['local', 'enabled Production'])('durable video quota admission in %s', (environment) => {
  beforeEach(() => {
    if (environment !== 'enabled Production') return;
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('TRA_PRODUCTION_VIDEO_ENABLED', '1');
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_fixture', CLERK_SECRET_KEY: 'sk_live_fixture',
      OPENAI_API_KEY: 'fixture-provider', R2_ACCOUNT_ID: 'fixture-account', R2_ACCESS_KEY_ID: 'fixture-access',
      R2_SECRET_ACCESS_KEY: 'fixture-secret', R2_BUCKET_NAME: 'fixture-production',
    })) vi.stubEnv(name, value);
  });

  it.each(cases.flatMap(entry => [429, 503].map(status => ({ ...entry, status }))))
  ('denies $name with $status before job claims, source reads or providers', async ({ route, body, group, status }) => {
    const denial = new Response(null, { status, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '60' } });
    mocks.quota.mockResolvedValue(denial);
    expect(await route(request(body()))).toBe(denial);
    expect(mocks.quota).toHaveBeenCalledExactlyOnceWith('operator', group, 1);
    expect(mocks.access).toHaveBeenCalledTimes(1); expectNoWork();
  });

  it.each(cases)('admits $name once before downstream work', async ({ route, body, group, first }) => {
    expect((await route(request(body()))).status).toBe(200);
    expect(mocks.quota).toHaveBeenCalledExactlyOnceWith('operator', group, 1);
    expect(mocks.quota.mock.invocationCallOrder[0]).toBeLessThan(first.mock.invocationCallOrder[0]);
  });

  it.each([401, 403, 503])('keeps all three authentication boundaries ahead of parsing and quota: %i', async status => {
    mocks.access.mockResolvedValue({ allowed: false, status, error: 'Denied' });
    for (const route of [job, selection, preview]) {
      const input = { json: vi.fn() } as unknown as Request;
      expect((await route(input)).status).toBe(status); expect(input.json).not.toHaveBeenCalled();
    }
    expect(mocks.quota).not.toHaveBeenCalled(); expectNoWork();
  });

  it.each([
    { route: job, body: { action: 'START', mediaId: 'bad' } },
    { route: job, body: { action: 'ADVANCE', locator: {} } },
    { route: job, body: { action: 'RETRY', locator: null } },
    { route: selection, body: { concept: 'Consultation', locator: {} } },
    { route: preview, body: { ...frameRequest, mediaId: 'bad' } },
  ])('rejects malformed source/locator input before quota: %#', async ({ route, body }) => {
    expect((await route(request(body))).status).toBe(400);
    expect(mocks.quota).not.toHaveBeenCalled(); expectNoWork();
  });

  it('rejects stale analyzer settings without consuming quota', async () => {
    const stale = { ...locator(), analyzerFingerprintSha256: '0'.repeat(64) };
    expect((await job(request({ action: 'ADVANCE', locator: stale }))).status).toBe(409);
    expect((await selection(request({ locator: stale, concept: 'Consultation' }))).status).toBe(409);
    expect(mocks.quota).not.toHaveBeenCalled(); expectNoWork();
  });

  it('preserves read-only reopening and STATUS polling even when work quota is exhausted', async () => {
    mocks.quota.mockResolvedValue(new Response(null, { status: 429 }));
    expect((await GET(new Request(`http://localhost/jobs?mediaId=${mediaId}`))).status).toBe(200);
    expect((await job(request({ action: 'STATUS', locator: locator() }))).status).toBe(200);
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith({ action: 'STATUS', locator: locator() }, expect.anything());
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('retains the server deadline across quota admission', async () => {
    let clock = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    mocks.quota.mockImplementation(async () => { clock = 99_000; return null; });
    await job(request({ action: 'START', mediaId }));
    expect(mocks.execute.mock.calls[0][1]).toEqual({ deadlineAtMs: 296_000 });
  });

  it('keeps disabled Production ahead of parsing and quota', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('TRA_PRODUCTION_VIDEO_ENABLED', '0');
    for (const route of [job, selection, preview]) {
      const input = { json: vi.fn() } as unknown as Request;
      expect((await route(input)).status).toBe(404); expect(input.json).not.toHaveBeenCalled();
    }
    expect(mocks.quota).not.toHaveBeenCalled(); expectNoWork();
  });
});
