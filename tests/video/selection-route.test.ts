import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hydrate: vi.fn(), load: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({}) }));
vi.mock('@/lib/media/source-hydration', async (original) => ({ ...await original<typeof import('@/lib/media/source-hydration')>(), hydrateCreativeSourceSelections: mocks.hydrate }));
vi.mock('@/lib/video/library-service', async (original) => ({ ...await original<typeof import('@/lib/video/library-service')>(), loadVideoFrameLibrary: mocks.load }));
vi.mock('@/lib/video/concept-selection', () => ({ selectVideoFramesForConcept: mocks.select }));
import { POST } from '@/app/api/video/selection/route';

const id = `media_${'a'.repeat(32)}`;
const source = { role: 'TRA_VIDEO', media: { id }, stored: { buffer: Buffer.from('server bytes') } };
const post = (body: object) => new Request('http://localhost/api/video/selection', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); mocks.hydrate.mockResolvedValue([source]); mocks.load.mockResolvedValue({ id: 'library' }); });
afterEach(() => vi.unstubAllEnvs());

it('hydrates the TRA video, uses its cached library, and returns a selection', async () => {
  mocks.select.mockResolvedValue({ frames: [{ frameId: 'frame', reason: 'Clear visual.' }] });
  const response = await POST(post({ mediaId: id, concept: 'Tax relief proof' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ selection: { frames: [{ frameId: 'frame', reason: 'Clear visual.' }] } });
  expect(mocks.hydrate).toHaveBeenCalledWith({}, [{ mediaId: id, role: 'TRA_VIDEO' }]);
  expect(mocks.select).toHaveBeenCalledWith({ id: 'library' }, 'Tax relief proof');
});

it('rejects invalid requests before hydrating or selecting and requires an analysis cache', async () => {
  expect((await POST(post({ mediaId: id, concept: ' ' }))).status).toBe(400);
  expect((await POST(post({ mediaId: '../video', concept: 'Concept' }))).status).toBe(400);
  expect(mocks.hydrate).not.toHaveBeenCalled();
  mocks.load.mockResolvedValue(null);
  expect((await POST(post({ mediaId: id, concept: 'Concept' }))).status).toBe(409);
  expect(mocks.select).not.toHaveBeenCalled();
});

it('returns a production 404 before reading source or calling the model', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect((await POST(post({ mediaId: id, concept: 'Concept' }))).status).toBe(404);
  expect(mocks.hydrate).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
});
