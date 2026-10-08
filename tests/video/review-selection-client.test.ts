import { describe, expect, it, vi } from 'vitest';
import { createReviewDraftClient, LAST_VIDEO_REVIEW, rememberReviewDraft, replaceReviewVideo,
  reviewDraftIdForReopen, type ReviewDraftResponse } from '@/lib/video/review-selection-client';
import type { ReviewSelectionChoices } from '@/lib/video/review-selection';

const id = `review_${'a'.repeat(32)}`, other = `review_${'b'.repeat(32)}`;
const video = { locator: { version: 1 as const, sourceVideoMediaId: `media_${'c'.repeat(32)}`, sourceVideoContentHash: 'd'.repeat(64),
  analyzerFingerprintSha256: 'e'.repeat(64) }, libraryId: `video-library:${'f'.repeat(64)}`, librarySha256: '1'.repeat(64), preparationSha256: '2'.repeat(64) };
const frame = { frameId: 'selected', representativeFrameId: 'representative', candidateIndex: 1, timestampMs: 1000, frameSha256: '3'.repeat(64) };
const empty = (): ReviewSelectionChoices => ({ video: null, frames: null, claims: null, companyProfile: null });
const selected = (): ReviewSelectionChoices => ({ video, frames: [frame], claims: [
  { type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 1 }, { type: 'VIDEO_ON_SCREEN', frame, statementIndex: 0 },
  { type: 'COMPANY_PROFILE', profileVersion: 'tra-company-profile-v2', profileSha256: '4'.repeat(64), section: 'knowledgeBase',
    field: 'servicesOffers', start: 0, end: 4 }], companyProfile: { knowledgeBase: { servicesOffers: 'Exact offer.' } } });
const saved = (choices = selected(), revision = 'revision-1'): ReviewDraftResponse => ({
  draft: { version: 1, artifactType: 'VIDEO_REVIEW_DRAFT', providerEligible: false, id, choices,
    claimSnapshots: [{ reference: choices.claims![0], wording: 'Exact source wording.', context: { type: 'VIDEO_TRANSCRIPT', segments: [] } }], updatedAtMs: 1 },
  revision, issues: [], transcriptContext: null, profileSource: choices.companyProfile ? 'OPERATOR_SNAPSHOT' : null });
const store = () => { const values = new Map<string, string>(); return { values,
  getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) }; };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('server-authoritative review draft restoration', () => {
  it.each(['review', 'draft'])('prioritizes explicit %s URL IDs over browser convenience IDs', async parameter => {
    const storage = store(); storage.setItem(LAST_VIDEO_REVIEW, other);
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(saved()));
    const client = createReviewDraftClient({ request });
    const restored = await client.load(reviewDraftIdForReopen(new URL(`http://localhost/?${parameter}=${id}`), storage)!);
    expect(restored).toEqual(saved()); expect(client.getState().choices).toEqual(selected());
    expect(request).toHaveBeenCalledWith(`/api/video/review-selection?id=${id}`, { cache: 'no-store' });
  });
  it('restores only server state via browser ID on refresh/reopen and never requests paid work', async () => {
    const storage = store(); const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(saved()));
    for (let reopen = 0; reopen < 2; reopen++) {
      const client = createReviewDraftClient({ request, onSaved: value => rememberReviewDraft(value, storage) });
      await client.load(reviewDraftIdForReopen(new URL(reopen ? 'http://localhost/' : `http://localhost/?review=${id}`), storage)!);
      expect(client.getState().saved).toEqual(saved());
    }
    expect(storage.values).toEqual(new Map([[LAST_VIDEO_REVIEW, id]]));
    expect(request.mock.calls.every(([url, init]) => String(url).startsWith('/api/video/review-selection?id=') && !init?.method)).toBe(true);
  });
  it('keeps explicit invalid/missing IDs authoritative instead of substituting the remembered draft', async () => {
    const storage = store(); storage.setItem(LAST_VIDEO_REVIEW, other);
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'Draft missing' }, { status: 404 }));
    const client = createReviewDraftClient({ request });
    const explicit = reviewDraftIdForReopen(new URL(`http://localhost/?review=${id}`), storage)!;
    await expect(client.load(explicit)).rejects.toThrow('Draft missing');
    expect(client.getState().saved).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
    await expect(client.load('invalid')).rejects.toThrow('ID is invalid'); expect(request).toHaveBeenCalledTimes(1);
    expect(reviewDraftIdForReopen(new URL('http://localhost/?review='), storage)).toBe('');
  });
  it.each([{ value: null }, { value: [] }])('preserves untouched/explicitly empty selections ($value)', async ({ value }) => {
    const choices = { ...empty(), frames: value, claims: value };
    const response = { ...saved(), draft: { ...saved().draft, choices, claimSnapshots: [] } };
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(response)); const client = createReviewDraftClient({ request });
    await client.load(id); expect(client.getState().choices).toEqual(choices);
    await client.save(choices); expect(JSON.parse(request.mock.calls[1][1]!.body as string).choices).toEqual(choices);
  });
  it('restores source issues, exact snapshots and server revision without substituting browser source data', async () => {
    const response = { ...saved(), issues: [{ source: 'VIDEO', message: 'Source missing' }, { source: 'CLAIM', index: 1, message: 'Statement changed' }] };
    const client = createReviewDraftClient({ request: vi.fn<typeof fetch>().mockResolvedValue(Response.json(response)) });
    await client.load(id); expect(client.getState().saved).toEqual(response);
  });
  it('works with disabled browser storage and stores no choices locally', () => {
    const storage = { getItem: () => { throw new Error('Disabled'); }, setItem: () => { throw new Error('Disabled'); } };
    expect(reviewDraftIdForReopen(new URL(`http://localhost/?review=${id}`), storage)).toBe(id);
    expect(reviewDraftIdForReopen(new URL('http://localhost/'), storage)).toBeNull();
    expect(() => rememberReviewDraft(id, storage)).not.toThrow();
  });
});

describe('serialized conditional review writes', () => {
  it('keeps a missing reopened draft blocked after reload rather than silently discarding the revision', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: 'Draft missing' }, { status: 404 }));
    const client = createReviewDraftClient({ request });
    await expect(client.load(id)).rejects.toThrow('Draft missing');
    await expect(client.recover()).rejects.toThrow('Draft missing');
    expect(client.getState().error).toContain('Draft missing');
  });
  it('recovers a committed first write after a lost response using its stable ID and server revision', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(Response.json(saved()));
    const client = createReviewDraftClient({ request, createId: () => id });
    await expect(client.save(selected())).rejects.toThrow('Connection lost');
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).id).toBe(id);
    await client.recover(); expect(request.mock.calls[1][0]).toBe(`/api/video/review-selection?id=${id}`);
    expect(client.getState()).toMatchObject({ error: '', saved: { revision: 'revision-1' }, choices: selected() });
  });
  it('keeps visible first choices after authoritative 404, allowing explicit retry with the same ID', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(Response.json({ error: 'Not found' }, { status: 404 })).mockResolvedValueOnce(Response.json(saved()));
    const client = createReviewDraftClient({ request, createId: () => id });
    await expect(client.save(selected())).rejects.toThrow(); await client.recover(); await client.save(client.getState().choices!);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init!.body as string).id)).toEqual([id, id]);
  });
  it('serializes writes, uses returned revisions and prevents an old response from replacing newer operator choices', async () => {
    const first = deferred<Response>();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(saved())).mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(Response.json(saved({ ...selected(), frames: [] }, 'revision-3')));
    const client = createReviewDraftClient({ request }); await client.load(id);
    const older = client.save(selected()); await Promise.resolve();
    const latest = client.save({ ...selected(), frames: [] });
    expect(request).toHaveBeenCalledTimes(2); expect(client.getState().choices!.frames).toEqual([]);
    first.resolve(Response.json(saved(selected(), 'revision-2'))); await older;
    expect(client.getState().choices!.frames).toEqual([]); await latest;
    expect(request.mock.calls.slice(1).map(([, init]) => JSON.parse(init!.body as string).expectedRevision)).toEqual(['revision-1', 'revision-2']);
    expect(client.getState()).toMatchObject({ pending: 0, error: '', saved: { revision: 'revision-3' }, choices: { frames: [] } });
  });
  it('queues initial creation once, then saves subsequent choices under the returned draft ID', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(saved())).mockResolvedValueOnce(Response.json(saved(selected(), 'revision-2')));
    const client = createReviewDraftClient({ request, createId: () => id }); await Promise.all([client.save(selected()), client.save(selected())]);
    expect(request.mock.calls.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
      { id, expectedRevision: null, choices: selected() }, { id, expectedRevision: 'revision-1', choices: selected() }]);
  });
  it.each([409, 503])('stops queued saves after HTTP %s, preserves newest local choices and reloads before writing again', async status => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(saved())).mockResolvedValueOnce(Response.json({ error: 'Changed or unavailable' }, { status }));
    const client = createReviewDraftClient({ request }); await client.load(id);
    const results = await Promise.allSettled([client.save(selected()), client.save({ ...selected(), frames: [] })]);
    expect(results.every(result => result.status === 'rejected')).toBe(true); expect(request).toHaveBeenCalledTimes(2);
    expect(client.getState()).toMatchObject({ conflict: status === 409, choices: { frames: [] }, saved: { revision: 'revision-1' } });
    request.mockImplementation(async () => Response.json(saved(selected(), 'concurrent-revision'))); await client.load(id);
    expect(client.getState()).toMatchObject({ choices: selected(), error: '', conflict: false });
    await client.save(selected()); expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string).expectedRevision).toBe('concurrent-revision');
  });
  it.each([401, 403, 409, 503])('retains HTTP %s cause across queued taps, then restores saved choices for explicit retry', async status => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(saved()))
      .mockResolvedValueOnce(new Response('Not JSON', { status }));
    const client = createReviewDraftClient({ request }); await client.load(id);
    await Promise.allSettled([client.save(selected()), client.save({ ...selected(), frames: [] })]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(client.getState().error).toContain(`HTTP ${status}`);
    expect(client.getState().error).toContain(status === 401 ? 'Sign in again' : status === 403 ? 'approved TRA operator' : status === 409 ? 'newer saved revision' : 'could not be confirmed');
    expect(client.getState().saved).toEqual(saved());
    request.mockResolvedValueOnce(Response.json(saved())); await client.load(id);
    expect(client.getState()).toMatchObject({ error: '', conflict: false, choices: selected() });
    request.mockResolvedValueOnce(Response.json(saved(selected(), 'revision-2'))); await client.save(selected());
    expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string).expectedRevision).toBe('revision-1');
  });
  it('stops after a lost connection rather than replaying an uncertain write', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('Connection lost')); const client = createReviewDraftClient({ request });
    await expect(client.save(selected())).rejects.toThrow('Connection lost');
    await expect(client.save(selected())).rejects.toThrow('server reload'); expect(request).toHaveBeenCalledTimes(1);
  });
  it('clears only dependent video choices on replacement, preserving exact profile/Proof choices and null semantics', () => {
    const replacement = { ...video, librarySha256: '9'.repeat(64) };
    const next = replaceReviewVideo(selected(), replacement);
    expect(next).toEqual({ ...selected(), video: replacement, frames: [], claims: [selected().claims![2]] });
    expect(replaceReviewVideo(selected(), video)).toEqual(selected());
    expect(replaceReviewVideo(empty(), video)).toEqual({ ...empty(), video });
    expect(replaceReviewVideo(selected(), null).claims).toEqual([selected().claims![2]]);
  });
});
