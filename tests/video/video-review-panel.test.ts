import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)>, cleanups: [] as Array<() => void> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => { const slot = hooks.cursor++; if (!(slot in hooks.values)) hooks.values[slot] = value;
    return [hooks.values[slot], (next: unknown) => { hooks.values[slot] = typeof next === 'function' ? next(hooks.values[slot]) : next; }]; },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); } }));
import { SavedVideoReviewSummary, VideoReviewPanel, toggleReviewFrame, type ReviewSource } from '@/components/creative-generator/video-review-panel';
import type { useVideoReviewDraft } from '@/components/creative-generator/use-video-review-draft';

const mediaId = `media_${'a'.repeat(32)}`;
const video = { locator: { sourceVideoMediaId: mediaId }, libraryId: 'library' };
const bindings = Array.from({ length: 5 }, (_, candidateIndex) => ({ frameId: `frame-${candidateIndex}`, representativeFrameId: `representative-${candidateIndex}`,
  candidateIndex, timestampMs: candidateIndex * 4000, frameSha256: `${candidateIndex}` }));
const source = { status: { phase: 'COMPLETE' }, review: { video, frameBindings: bindings,
  onScreenStatements: [], library: { transcript: { segments: [] }, representativeFrames: bindings.slice(0, 4).map(binding => ({ ...binding, thumbnailDataUrl: `data:image/jpeg;base64,${binding.frameId}` })) } } } as unknown as ReviewSource;
let draft: ReturnType<typeof useVideoReviewDraft>, request: ReturnType<typeof vi.fn<typeof fetch>>;
const render = (videos = [{ id: mediaId, name: 'Source' }]) => { hooks.cursor = 0; hooks.effects = []; return VideoReviewPanel({ videos, draft }); };
const nodes = (tree: unknown): ReactElement<Record<string, unknown>>[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
  : 'props' in tree ? [tree as ReactElement<Record<string, unknown>>, ...nodes((tree as ReactElement<{ children?: unknown }>).props.children)] : [];
const run = (effect: number) => { const cleanup = hooks.effects[effect](); if (cleanup) hooks.cleanups.push(cleanup); };
const html = () => renderToStaticMarkup(render());
beforeEach(() => {
  hooks.values = []; hooks.cleanups = [];
  draft = { state: { pending: 0, error: '', conflict: false, saved: null, choices: { video, frames: null, claims: null, companyProfile: null } },
    canGenerate: () => true, update: vi.fn(async (_video, change) => { draft.state.choices = change(draft.state.choices!); }) } as unknown as ReturnType<typeof useVideoReviewDraft>;
  request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(source)); vi.stubGlobal('fetch', request);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { hooks.cleanups.forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.useRealTimers();
  expect(request.mock.calls.every(([url, init]) => String(url).startsWith('/api/video/review-sources?') && !init?.method)).toBe(true); });
const loaded = async () => { render(); run(0); await vi.waitFor(() => expect(hooks.values[1]).toEqual(source)); };

describe('native Create frame review', () => {
  it('displays the frozen saved review independently of unsaved choices and source discovery', () => {
    const saved = { draft: { id: 'review-a', choices: { ...draft.state.choices, frames: [bindings[2]] },
      claimSnapshots: [{ wording: 'Exact frozen A wording.' }] }, revision: 'revision-a', issues: [{ source: 'VIDEO', message: 'A missing' }] };
    draft.state.saved = saved as never;
    draft.state.choices = { video: { locator: { sourceVideoMediaId: 'video-b' } }, frames: [], claims: [], companyProfile: null } as never;
    const markup = renderToStaticMarkup(SavedVideoReviewSummary({ draft }));
    expect(markup).toContain('data-video-id="' + mediaId + '"');
    expect(markup).toContain('data-review-id="review-a"'); expect(markup).toContain('data-review-revision="revision-a"');
    expect(markup).toContain('data-frame-id="frame-2"'); expect(markup).toContain('Selected frame at 00:08');
    expect(markup).toContain('Exact frozen A wording.'); expect(markup).not.toContain('video-b');
    expect(draft.state.saved).toBe(saved); expect(draft.update).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it('renders cold Create with no video or restored source without touching a null source', () => {
    expect(VideoReviewPanel({ videos: [], draft: { ...draft, state: { ...draft.state, choices: null } } })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it('restores a saved neighboring choice with its exact local thumbnail without saving or copying observations', async () => {
    draft.state.choices!.frames = [bindings[4]]; await loaded();
    request.mockResolvedValueOnce(Response.json({ ...source, review: { ...source.review, previews: [{
      binding: bindings[4], providerEligible: false, thumbnailDataUrl: 'data:image/jpeg;base64,restored-neighbor' }] } }));
    render(); run(1); await vi.waitFor(() => expect(hooks.values[5]).toHaveProperty('frame-4'));
    expect(html()).toContain('restored-neighbor'); expect(nodes(render()).filter(node => node.type === 'input').at(-1)!.props.checked).toBe(true);
    expect(draft.update).not.toHaveBeenCalled(); expect(draft.state.choices!.claims).toBeNull();
  });
  it('restores 50 selected neighbors in serial batches of at most 24 without changing choices', async () => {
    await loaded();
    const neighbors = Array.from({ length: 50 }, (_, index) => ({ ...bindings[4], frameId: `neighbor-${index}`, candidateIndex: index + 4 }));
    const largeSource = { ...source, review: { ...source.review!, frameBindings: [...bindings.slice(0, 4), ...neighbors] } };
    hooks.values[1] = largeSource; draft.state.choices!.frames = neighbors;
    let active = 0, peak = 0; const sizes: number[] = [];
    request.mockImplementation(async url => {
      active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
      const indexes = new URL(String(url), 'http://localhost').searchParams.get('candidateIndexes')!.split(',').map(Number);
      sizes.push(indexes.length);
      return Response.json({ ...largeSource, review: { ...largeSource.review, previews: indexes.map(index => ({
        binding: neighbors[index - 4], providerEligible: false, thumbnailDataUrl: 'neighbor' })) } });
    });
    render(); run(1); await vi.waitFor(() => expect(Object.keys(hooks.values[5] as object)).toHaveLength(50));
    expect(peak).toBe(1); expect(sizes).toEqual([24, 24, 2]); expect(request).toHaveBeenCalledTimes(4);
    expect(draft.state.choices!.frames).toEqual(neighbors); expect(draft.update).not.toHaveBeenCalled();
  });
  it('keeps failed restored previews visible with exact identity and time; retries and deselects independently', async () => {
    draft.state.choices!.frames = [bindings[4]]; await loaded();
    request.mockResolvedValueOnce(Response.json({ error: 'Extraction unavailable' }, { status: 409 }));
    render(); run(1); await vi.waitFor(() => expect(hooks.values[2]).toContain('Extraction unavailable'));
    expect(html()).toContain('Preview unavailable'); expect(html()).toContain('frame-4'); expect(html()).toContain('16000 ms');
    const check = nodes(render()).filter(node => node.type === 'input').at(-1)!;
    expect(check.props.checked).toBe(true); expect(check.props.disabled).toBe(false);
    (nodes(render()).find(node => node.type === 'button' && node.props.children === 'Retry preview')!.props.onClick as () => void)();
    expect(draft.update).not.toHaveBeenCalled(); expect(draft.state.choices!.frames).toEqual([bindings[4]]);
    request.mockResolvedValueOnce(Response.json({ ...source, review: { ...source.review, previews: [{
      binding: bindings[4], providerEligible: false, thumbnailDataUrl: 'recovered' }] } }));
    render(); run(1); await vi.waitFor(() => expect(html()).toContain('recovered'));
    (nodes(render()).find(node => node.type === 'img' && node.props.src === 'recovered')!.props.onError as () => void)();
    expect(html()).toContain('Preview unavailable');
    (check.props.onChange as () => void)(); expect(draft.state.choices!.frames).toEqual([]);
  });
  it.each(['source', 'binding', 'eligibility'])('rejects preview %s drift while keeping saved choices selectable', async drift => {
    draft.state.choices!.frames = [bindings[4]]; await loaded();
    const preview = { binding: drift === 'binding' ? { ...bindings[4], timestampMs: 9 } : bindings[4],
      providerEligible: drift === 'eligibility', thumbnailDataUrl: 'invalid' };
    request.mockResolvedValueOnce(Response.json({ ...source, review: { ...source.review,
      video: drift === 'source' ? { ...video, libraryId: 'changed' } : video, previews: [preview] } }));
    render(); run(1); await vi.waitFor(() => expect(hooks.values[2]).toContain('changed'));
    expect(hooks.values[5]).toEqual({}); expect(draft.state.choices!.frames).toEqual([bindings[4]]);
    expect(nodes(render()).filter(node => node.type === 'input').at(-1)!.props.disabled).toBe(false);
  });
  it('ignores a late source response after switching videos, even when transport ignores abort', async () => {
    let resolve!: (response: Response) => void; request.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    render(); run(0); hooks.cleanups[0](); hooks.values[0] = 'other'; hooks.cursor = 0; hooks.effects = [];
    const other = { ...source, review: { ...source.review, video: { ...video, locator: { sourceVideoMediaId: 'other' } } } };
    request.mockResolvedValueOnce(Response.json(other));
    VideoReviewPanel({ videos: [{ id: 'other', name: 'Other' }], draft }); run(0);
    await vi.waitFor(() => expect(hooks.values[1]).toEqual(other));
    resolve(Response.json(source)); await Promise.resolve(); await Promise.resolve();
    expect(hooks.values[1]).toEqual(other); expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it('opens completed material with real representative thumbnails/timestamps and supports select/deselect without paid work', async () => {
    await loaded(); expect(html()).toContain('Video material ready'); expect(html()).toContain('data:image/jpeg;base64,frame-1'); expect(html()).toContain('00:04');
    const checkbox = nodes(render()).find(node => node.type === 'input')!;
    (checkbox.props.onChange as () => void)(); expect(draft.state.choices!.frames).toEqual([bindings[0]]);
    (nodes(render()).find(node => node.type === 'input')!.props.onChange as () => void)();
    expect(draft.state.choices!.frames).toEqual([]); expect(request).toHaveBeenCalledTimes(1);
  });
  it('preserves untouched null and allows all analyzed frames while saving and deselecting', async () => {
    await loaded(); expect(draft.state.choices!.frames).toBeNull();
    draft.state.choices!.frames = bindings.slice(0, 3);
    const checks = nodes(render()).filter(node => node.type === 'input');
    expect(checks.map(node => node.props.disabled)).toEqual([false, false, false, false]);
    expect(toggleReviewFrame(bindings.slice(0, 3), bindings[3])).toEqual(bindings.slice(0, 4));
    expect(toggleReviewFrame(bindings, bindings[1])).toEqual(bindings.filter(item => item !== bindings[1]));
    draft.state.pending = 2;
    expect(nodes(render()).filter(node => node.type === 'input').every(node => !node.props.disabled)).toBe(true);
    expect(html()).toContain('3 selected');
  });
  it.each(['error', 'conflict', 'issues', 'generation'])('explains the %s block without altering choices', async reason => {
    await loaded(); const before = structuredClone(draft.state.choices);
    if (reason === 'error') draft.state.error = 'HTTP 401: Sign in again, then reload saved review.';
    if (reason === 'conflict') draft.state.conflict = true;
    if (reason === 'issues') draft.state.saved = { draft: { claimSnapshots: [] }, issues: [{ source: 'VIDEO', message: 'Missing source' }] } as never;
    hooks.cursor = 0;
    const tree = VideoReviewPanel({ videos: [{ id: mediaId, name: 'Source' }], draft, disabled: reason === 'generation' });
    expect(nodes(tree).filter(node => node.type === 'input').every(node => node.props.disabled)).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain(reason === 'generation' ? 'Stop or finish generation' : reason === 'issues' ? 'unavailable or changed' : reason === 'conflict' ? 'latest revision' : 'Sign in again');
    expect(draft.state.choices).toEqual(before); expect(draft.update).not.toHaveBeenCalled();
  });
  it('reads/polls incomplete work until completion without starting/resuming analysis', async () => {
    vi.useFakeTimers(); const incomplete = { ...source, status: { phase: 'OBSERVING' }, review: null };
    request.mockResolvedValueOnce(Response.json(incomplete)); render(); run(0); await vi.advanceTimersByTimeAsync(0);
    expect(html()).not.toContain('Video material ready'); await vi.advanceTimersByTimeAsync(3000);
    expect(html()).toContain('Video material ready'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('loads exact neighboring candidate previews, retains them for selection, and makes no observations for neighbors', async () => {
    await loaded(); hooks.values[4] = true; // Expand nearby frames.
    const button = nodes(render()).find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.join('') === 'Preview 00:16')!;
    (button.props.onClick as () => void)();
    const preview = { binding: bindings[4], providerEligible: false, thumbnailDataUrl: 'data:image/jpeg;base64,neighbor' };
    request.mockResolvedValueOnce(Response.json({ ...source, review: { ...source.review, previews: [preview] } })); render(); run(1);
    await vi.waitFor(() => expect(hooks.values[5]).toHaveProperty('frame-4'));
    const check = nodes(render()).filter(node => node.type === 'input').at(-1)!; (check.props.onChange as () => void)();
    expect(draft.state.choices!.frames).toEqual([bindings[4]]); expect(draft.state.choices!.claims).toBeNull();
    expect(request.mock.calls[1][0]).toContain('candidateIndexes=4');
  });
  it('collapse/reopen preserves choices; saving/failure/conflict remain visible; no-video is unchanged', async () => {
    await loaded(); const choices = structuredClone(draft.state.choices);
    const collapse = nodes(render()).find(node => node.type === 'button' && node.props.children === 'Collapse')!;
    (collapse.props.onClick as () => void)(); expect(html()).toContain('Video material · 0 frames');
    const edit = nodes(render()).find(node => node.type === 'button' && node.props.children === 'Edit')!;
    (edit.props.onClick as () => void)(); expect(draft.state.choices).toEqual(choices);
    draft.state.saved = { issues: [], draft: { claimSnapshots: [] } } as never; expect(html()).toContain('Saved ✓');
    draft.state.pending = 1; expect(html()).toContain('Saving…');
    draft.state.pending = 0; draft.state.error = 'Save failed'; expect(html()).toContain('Save failed');
    draft.state.conflict = true; expect(html()).toContain('Conflict / reload required');
    hooks.cursor = 0; expect(VideoReviewPanel({ videos: [], draft: { ...draft, state: { ...draft.state, choices: null } } })).toBeNull();
  });
  it('counts retained non-video statements after switching to another completed video', async () => {
    const otherId = `media_${'b'.repeat(32)}`;
    draft.state.choices!.claims = [{ type: 'PROOF', proofId: 'review' }, { type: 'PROOF', proofId: 'case-study' },
      { type: 'COMPANY_PROFILE', field: 'servicesOffers' }, { type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 }] as never;
    await loaded();
    const videos = [{ id: mediaId, name: 'Source' }, { id: otherId, name: 'Other' }];
    const select = nodes(render(videos)).find(node => node.type === 'select')!;
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: otherId } });
    expect(hooks.values[0]).toBe(otherId);
    const otherSource = { ...source, review: { ...source.review, video: { ...video, locator: { sourceVideoMediaId: otherId } } } };
    request.mockResolvedValueOnce(Response.json(otherSource)); render(videos); run(0);
    await vi.waitFor(() => expect(hooks.values[1]).toEqual(otherSource));
    const collapse = nodes(render(videos)).find(node => node.type === 'button' && node.props.children === 'Collapse')!;
    (collapse.props.onClick as () => void)();
    expect(renderToStaticMarkup(render(videos))).toContain('Video material · 0 frames · 3 statements');
  });
});
