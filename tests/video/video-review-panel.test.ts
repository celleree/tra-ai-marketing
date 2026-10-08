import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)>, cleanups: [] as Array<() => void> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (value: unknown) => { const slot = hooks.cursor++; if (!(slot in hooks.values)) hooks.values[slot] = value;
    return [hooks.values[slot], (next: unknown) => { hooks.values[slot] = typeof next === 'function' ? next(hooks.values[slot]) : next; }]; },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); } }));
import { VideoReviewPanel, toggleReviewFrame, type ReviewSource } from '@/components/creative-generator/video-review-panel';
import type { useVideoReviewDraft } from '@/components/creative-generator/use-video-review-draft';

const mediaId = `media_${'a'.repeat(32)}`;
const video = { locator: { sourceVideoMediaId: mediaId }, libraryId: 'library' };
const bindings = Array.from({ length: 5 }, (_, candidateIndex) => ({ frameId: `frame-${candidateIndex}`, representativeFrameId: `representative-${candidateIndex}`,
  candidateIndex, timestampMs: candidateIndex * 4000, frameSha256: `${candidateIndex}` }));
const source = { status: { phase: 'COMPLETE' }, review: { video, frameBindings: bindings,
  library: { representativeFrames: bindings.slice(0, 4).map(binding => ({ ...binding, thumbnailDataUrl: `data:image/jpeg;base64,${binding.frameId}` })) } } } as unknown as ReviewSource;
let draft: ReturnType<typeof useVideoReviewDraft>, request: ReturnType<typeof vi.fn<typeof fetch>>;
const render = () => { hooks.cursor = 0; hooks.effects = []; return VideoReviewPanel({ videos: [{ id: mediaId, name: 'Source' }], draft }); };
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
  it('restores a saved neighboring choice with its exact local thumbnail without saving or copying observations', async () => {
    draft.state.choices!.frames = [bindings[4]]; await loaded();
    request.mockResolvedValueOnce(Response.json({ ...source, review: { ...source.review, preview: {
      binding: bindings[4], providerEligible: false, thumbnailDataUrl: 'data:image/jpeg;base64,restored-neighbor' } } }));
    render(); run(1); await vi.waitFor(() => expect(hooks.values[5]).toHaveProperty('frame-4'));
    expect(html()).toContain('restored-neighbor'); expect(nodes(render()).filter(node => node.type === 'input').at(-1)!.props.checked).toBe(true);
    expect(draft.update).not.toHaveBeenCalled(); expect(draft.state.choices!.claims).toBeNull();
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
  it('preserves untouched null and clearly prevents a fourth selection while allowing deselection', async () => {
    await loaded(); expect(draft.state.choices!.frames).toBeNull();
    draft.state.choices!.frames = bindings.slice(0, 3);
    const checks = nodes(render()).filter(node => node.type === 'input');
    expect(checks.map(node => node.props.disabled)).toEqual([false, false, false, true]);
    expect(toggleReviewFrame(bindings.slice(0, 3), bindings[3])).toEqual(bindings.slice(0, 3));
    expect(html()).toContain('Deselect one');
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
    request.mockResolvedValueOnce(Response.json({ ...source, review: { ...source.review, preview } })); render(); run(1);
    await vi.waitFor(() => expect(hooks.values[5]).toHaveProperty('frame-4'));
    const check = nodes(render()).filter(node => node.type === 'input').at(-1)!; (check.props.onChange as () => void)();
    expect(draft.state.choices!.frames).toEqual([bindings[4]]); expect(draft.state.choices!.claims).toBeNull();
    expect(request.mock.calls[1][0]).toContain('candidateIndex=4');
  });
  it('collapse/reopen preserves choices; saving/failure/conflict remain visible; no-video is unchanged', async () => {
    await loaded(); const choices = structuredClone(draft.state.choices);
    const collapse = nodes(render()).find(node => node.type === 'button' && node.props.children === 'Collapse')!;
    (collapse.props.onClick as () => void)(); expect(html()).toContain('Video material · 0 frames');
    const edit = nodes(render()).find(node => node.type === 'button' && node.props.children === 'Edit')!;
    (edit.props.onClick as () => void)(); expect(draft.state.choices).toEqual(choices);
    draft.state.saved = { issues: [] } as never; expect(html()).toContain('Saved ✓');
    draft.state.pending = 1; expect(html()).toContain('Saving…');
    draft.state.pending = 0; draft.state.error = 'Save failed'; expect(html()).toContain('Save failed');
    draft.state.conflict = true; expect(html()).toContain('Conflict / reload required');
    hooks.cursor = 0; expect(VideoReviewPanel({ videos: [], draft: { ...draft, state: { ...draft.state, choices: null } } })).toBeNull();
  });
});
