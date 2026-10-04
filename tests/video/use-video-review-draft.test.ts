import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_VIDEO_REVIEW } from '@/lib/video/review-selection-client';

const mocks = vi.hoisted(() => ({ effects: [] as Array<() => () => void>, update: vi.fn() }));
// Exercise Create's effect lifecycle and handlers without a browser or provider runtime.
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, mocks.update],
  useEffect: (effect: () => () => void) => { mocks.effects.push(effect); } }));
import { useVideoReviewDraft } from '@/components/creative-generator/use-video-review-draft';

const id = `review_${'a'.repeat(32)}`, mediaId = `media_${'b'.repeat(32)}`;
const response = { draft: { id, version: 1, artifactType: 'VIDEO_REVIEW_DRAFT', providerEligible: false, updatedAtMs: 1,
  choices: { video: { locator: { sourceVideoMediaId: mediaId } }, frames: [{ frameId: 'selected' }],
    claims: [{ type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 }], companyProfile: null }, claimSnapshots: [] },
  revision: 'revision-1', issues: [{ source: 'VIDEO', message: 'Source changed.' }], transcriptContext: null, profileSource: null };
let values: Map<string, string>, request: ReturnType<typeof vi.fn<typeof fetch>>, replace: ReturnType<typeof vi.fn>;
const mount = () => { const hook = useVideoReviewDraft(); const unmount = mocks.effects.at(-1)!(); return { hook, unmount }; };
const settled = () => vi.waitFor(() => expect(mocks.update.mock.calls.at(-1)?.[0].pending).toBe(0));
beforeEach(() => {
  vi.resetAllMocks(); mocks.effects = []; values = new Map(); replace = vi.fn();
  vi.stubGlobal('window', { location: { href: `http://localhost/?review=${id}` }, history: { replaceState: replace },
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } });
  request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === 'POST'
    ? Response.json({ ...response, draft: { ...response.draft, choices: JSON.parse(init.body as string).choices }, revision: 'revision-2', issues: [] })
    : Response.json(response)); vi.stubGlobal('fetch', request);
});
afterEach(() => { expect(request.mock.calls.every(([url]) => String(url).startsWith('/api/video/review-selection'))).toBe(true);
  vi.unstubAllGlobals(); });

describe('Create-owned saved review lifecycle', () => {
  it('loads URL choices and issues, remembers only the ID, and restores on browser fallback reopen without saves or paid work', async () => {
    const first = mount(); await settled();
    expect(mocks.update.mock.calls.at(-1)![0]).toMatchObject({ choices: response.draft.choices, saved: response });
    expect(values).toEqual(new Map([[LAST_VIDEO_REVIEW, id]])); expect(replace.mock.calls[0][2].searchParams.get('review')).toBe(id);
    first.unmount(); window.location.href = 'http://localhost/'; mount(); await settled();
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it('does not clear choices when the Create owner unmounts and ignores late UI updates', async () => {
    const view = mount(); view.unmount(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(1); expect(replace).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(1); // Only the initial pending-state publication occurred while mounted.
  });
  it('does not write for unrelated source removal, but persists clearing incompatible choices after restore', async () => {
    const { hook } = mount(); await settled(); await hook.removeVideo('unrelated'); expect(request).toHaveBeenCalledTimes(1);
    request.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      return Response.json({ ...response, draft: { ...response.draft, choices: body.choices }, revision: 'revision-2', issues: [] });
    });
    await hook.removeVideo(mediaId);
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toMatchObject({ id, expectedRevision: 'revision-1',
      choices: { video: null, frames: [], claims: [] } });
  });
  it('waits for restoration before removing its source, preventing delayed load from reviving incompatible choices', async () => {
    let resolve!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const { hook } = mount(); const removal = hook.removeVideo(mediaId); await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1); resolve(Response.json(response)); await removal;
    expect(request).toHaveBeenCalledTimes(2); expect(JSON.parse(request.mock.calls[1][1]!.body as string).choices.video).toBeNull();
  });
  it('allows reloading a URL draft after an initial missing-source/load failure', async () => {
    request.mockResolvedValueOnce(Response.json({ error: 'Temporarily unavailable' }, { status: 503 }));
    const { hook } = mount(); await settled();
    expect(mocks.update.mock.calls.at(-1)![0].error).toContain('Temporarily unavailable');
    await hook.reload(); expect(request).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls.at(-1)![0].saved).toEqual(response);
  });
  it('retains removal intent when initial restoration fails and clears dependent choices after a successful reload', async () => {
    let resolve!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const { hook } = mount(); const removal = hook.removeVideo(mediaId); await Promise.resolve();
    resolve(Response.json({ error: 'Connection unavailable' }, { status: 503 })); await removal;
    expect(request).toHaveBeenCalledTimes(1);
    request.mockImplementation(async (_url, init) => init?.method === 'POST'
      ? Response.json({ ...response, draft: { ...response.draft, choices: JSON.parse(init.body as string).choices }, revision: 'revision-2', issues: [] })
      : Response.json(response));
    await hook.reload();
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.parse(request.mock.calls[2][1]!.body as string)).toMatchObject({ id, expectedRevision: 'revision-1',
      choices: { video: null, frames: [], claims: [] } });
    expect(mocks.update.mock.calls.at(-1)![0]).toMatchObject({ choices: { video: null, frames: [], claims: [] },
      saved: { revision: 'revision-2' }, error: '' });
  });
});
