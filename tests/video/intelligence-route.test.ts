import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ requireOperatorAccess: vi.fn(async () => null), hydrate: vi.fn(), analyze: vi.fn(), load: vi.fn() }));
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess: mocks.requireOperatorAccess }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({}) }));
vi.mock('@/lib/media/source-hydration', async (original) => ({ ...await original<typeof import('@/lib/media/source-hydration')>(), hydrateCreativeSourceSelections: mocks.hydrate }));
vi.mock('@/lib/video/library-service', async (original) => ({ ...await original<typeof import('@/lib/video/library-service')>(), analyzeTraVideoIntelligence: mocks.analyze, loadVideoFrameLibrary: mocks.load }));
import { GET, POST } from '@/app/api/video/intelligence/route';

const id = `media_${'a'.repeat(32)}`;
const source = { role: 'TRA_VIDEO', media: { id, url: '/api/media/files/source.mp4' }, stored: { buffer: Buffer.from('server bytes') } };
const post = (body: object) => new Request('http://localhost/api/video/intelligence', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); mocks.requireOperatorAccess.mockResolvedValue(null); mocks.hydrate.mockResolvedValue([source]); });
afterEach(() => vi.unstubAllEnvs());

it('hydrates the requested TRA video and streams progress followed by complete analysis', async () => {
  mocks.analyze.mockImplementation(async (_source, options) => { options.onProgress('Analyzed 2 of 2 representatives'); return { library: { id: 'library' }, reused: false }; });
  const response = await POST(post({ mediaId: id }));
  expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual(['progress', 'complete']);
  expect(events[1]).toMatchObject({ library: { id: 'library' }, source: source.media, reused: false });
  expect(mocks.hydrate).toHaveBeenCalledWith({}, [{ mediaId: id, role: 'TRA_VIDEO' }]);
  expect(mocks.analyze).toHaveBeenCalledWith(source, expect.objectContaining({ force: false }));
  expect(JSON.stringify(events)).not.toContain('server bytes');
});

it('loads analysis without starting providers and reports stream failures', async () => {
  mocks.load.mockResolvedValue(null);
  expect(await (await GET(new Request(`http://localhost/api/video/intelligence?mediaId=${id}`))).json()).toEqual({ source: source.media, library: null });
  expect(mocks.analyze).not.toHaveBeenCalled();
  mocks.analyze.mockRejectedValue(new Error('Video vision failed (HTTP 429).'));
  const response = await POST(post({ mediaId: id }));
  expect(JSON.parse((await response.text()).trim())).toEqual({ type: 'error', error: 'Video vision failed (HTTP 429).' });
});

it('rejects malformed inputs and production requests before hydrating or running analysis', async () => {
  expect((await POST(post({ mediaId: '../source' }))).status).toBe(400);
  expect((await POST(new Request('http://localhost/api/video/intelligence', { method: 'POST', body: '{' }))).status).toBe(400);
  vi.stubEnv('NODE_ENV', 'production');
  expect((await POST(post({ mediaId: id }))).status).toBe(404);
  expect((await GET(new Request(`http://localhost/api/video/intelligence?mediaId=${id}`))).status).toBe(404);
  expect(mocks.hydrate).not.toHaveBeenCalled();
  expect(mocks.analyze).not.toHaveBeenCalled();
});
