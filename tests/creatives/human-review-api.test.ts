import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATCH } from '@/app/api/creatives/[creativeId]/route';
import { CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS } from '@/lib/creatives/human-review';

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/lib/creatives/storage', async original => ({ ...await original<object>(), updateCreativeReviewState: mocks.update }));
const id = `creative_${'a'.repeat(32)}`;
const now = '2026-09-07T12:00:00.000Z';
const checklist = () => Object.fromEntries(CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS.map(key => [key, 'PASS']));
const call = (body: unknown, creativeId = id) => PATCH(new Request('http://localhost/api/creatives/review', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ creativeId }) });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now)); mocks.update.mockReset().mockImplementation(async (creativeId, update) => ({ id: creativeId, ...update })); });
afterEach(() => vi.useRealTimers());

describe('server-owned creative human review API', () => {
  it.each([false, true])('derives the decision from every check (failure=%s)', async failed => {
    const checks = { ...checklist(), ...(failed ? { placementSafety: 'FAIL' } : {}) };
    const response = await call({ action: 'REVIEW', checklist: checks, notes: '  Operator review  ' });
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(id, { humanReview: { status: failed ? 'REJECTED' : 'APPROVED', reviewedAt: now, checklist: checks, notes: 'Operator review' } });
    expect((await response.json()).creative.humanReview.reviewedAt).toBe(now);
  });
  it.each(['ACTIVE', 'PAUSED'])('updates only the requested %s library state', async status => {
    expect((await call({ action: 'SET_LIFECYCLE', status })).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(id, { lifecycle: { status, updatedAt: now } });
  });
  it('omits blank optional notes', async () => {
    await call({ action: 'REVIEW', checklist: checklist(), notes: '  ' });
    expect(mocks.update.mock.calls[0][1].humanReview).not.toHaveProperty('notes');
  });
  it.each([
    null, [], { action: 'UNKNOWN' }, { action: 'REVIEW', checklist: {} },
    { action: 'REVIEW', checklist: { ...checklist(), placementSafety: 'UNKNOWN' } },
    { action: 'REVIEW', checklist: checklist(), status: 'APPROVED' },
    { action: 'REVIEW', checklist: checklist(), reviewedAt: now },
    { action: 'REVIEW', checklist: checklist(), notes: 'x'.repeat(2001) },
    { action: 'SET_LIFECYCLE', status: 'TESTING' },
    { action: 'SET_LIFECYCLE', status: 'ACTIVE', image: {} },
  ])('rejects malformed or caller-owned decision fields %#', async body => {
    expect((await call(body)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects invalid IDs and JSON without touching storage', async () => {
    expect((await call({}, 'invalid')).status).toBe(400);
    expect((await PATCH(new Request('http://localhost', { method: 'PATCH', body: '{' }), { params: Promise.resolve({ creativeId: id }) })).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('surfaces missing records and storage failures without reporting success', async () => {
    mocks.update.mockResolvedValueOnce(null);
    expect((await call({ action: 'SET_LIFECYCLE', status: 'PAUSED' })).status).toBe(404);
    mocks.update.mockRejectedValueOnce(new Error('internal storage details'));
    const response = await call({ action: 'SET_LIFECYCLE', status: 'PAUSED' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Creative review state could not be saved.' });
  });
});
