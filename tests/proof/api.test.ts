import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewProofRecord } from '@/lib/proof/types';

const mocks = vi.hoisted(() => ({
  addProofRecords: vi.fn(),
  listProofRecords: vi.fn(),
  requireOperatorAccess: vi.fn(),
  updateProofRecord: vi.fn(),
}));
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess: mocks.requireOperatorAccess }));
vi.mock('@/lib/proof/storage', () => ({
  addProofRecords: mocks.addProofRecords,
  listProofRecords: mocks.listProofRecords,
  updateProofRecord: mocks.updateProofRecord,
}));

import * as route from '@/app/api/proof/route';

const request = (method: string, body: unknown) =>
  new Request('http://localhost/api/proof', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const review = (updatedAt = '2026-09-10T12:00:00.000Z'): ReviewProofRecord => ({
  id: `proof_${'a'.repeat(32)}`,
  type: 'review',
  originalReviewText: '  Exact punctuation—unchanged.\nSecond line.  ',
  tags: [],
  status: 'ACTIVE',
  createdAt: '2026-09-10T12:00:00.000Z',
  updatedAt,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  mocks.requireOperatorAccess.mockResolvedValue(null);
  mocks.listProofRecords.mockResolvedValue([]);
  mocks.addProofRecords.mockImplementation(async (items) => items);
  mocks.updateProofRecord.mockImplementation(async (item) => item);
});

describe('Proof Library API', () => {
  it('requires operator access before reading inputs or storage', async () => {
    const denied = Response.json({ error: 'Denied' }, { status: 403 });
    mocks.requireOperatorAccess.mockResolvedValue(denied);
    const input = { json: vi.fn() } as unknown as Request;

    expect((await route.GET()).status).toBe(403);
    expect((await route.POST(input)).status).toBe(403);
    expect((await route.PATCH(input)).status).toBe(403);
    expect(input.json).not.toHaveBeenCalled();
    expect(mocks.listProofRecords).not.toHaveBeenCalled();
    expect(mocks.addProofRecords).not.toHaveBeenCalled();
  });

  it('lists persisted records for an authorized operator', async () => {
    mocks.listProofRecords.mockResolvedValue([review()]);
    const response = await route.GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [review()] });
  });

  it('creates server-owned IDs and preserves exact review text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T14:00:00.000Z'));
    const originalReviewText = '  Case, punctuation—AND line breaks.\nStay exact.  ';
    const response = await route.POST(request('POST', {
      items: [{ type: 'review', originalReviewText }],
    }));

    expect(response.status).toBe(201);
    const [saved] = mocks.addProofRecords.mock.calls[0][0] as ReviewProofRecord[];
    expect(saved.id).toMatch(/^proof_[a-f0-9]{32}$/);
    expect(saved.originalReviewText).toBe(originalReviewText);
    expect(saved).not.toHaveProperty('source');
    expect(saved).not.toHaveProperty('rating');
    expect(saved).toMatchObject({ tags: [], status: 'ACTIVE' });
  });

  it('rejects malformed or oversized batches before storage', async () => {
    expect((await route.POST(request('POST', { items: [] }))).status).toBe(400);
    expect((await route.POST(request('POST', {
      items: [{ type: 'review', originalReviewText: 'Valid', invented: 'no' }],
    }))).status).toBe(400);
    expect((await route.POST(request('POST', {
      items: Array.from({ length: 101 }, () => ({ type: 'review', originalReviewText: 'Valid' })),
    }))).status).toBe(400);
    expect(mocks.addProofRecords).not.toHaveBeenCalled();
  });

  it('keeps case-study facts separate from approved wording', async () => {
    const response = await route.POST(request('POST', { items: [{
      type: 'case-study',
      title: 'Case A',
      verifiedFacts: ['Fact one.'],
      approvedClaimWording: 'Approved wording only.',
      sourceNote: 'Verified source A.',
    }] }));
    expect(response.status).toBe(201);
    expect(mocks.addProofRecords.mock.calls[0][0][0]).toMatchObject({
      verifiedFacts: ['Fact one.'],
      approvedClaimWording: 'Approved wording only.',
    });
  });

  it('updates and deactivates using server-owned version timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T13:00:00.000Z'));
    mocks.listProofRecords.mockResolvedValue([review()]);
    const response = await route.PATCH(request('PATCH', {
      id: review().id,
      expectedUpdatedAt: review().updatedAt,
      status: 'INACTIVE',
      item: { type: 'review', originalReviewText: review().originalReviewText },
    }));

    expect(response.status).toBe(200);
    expect(mocks.updateProofRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'INACTIVE', updatedAt: '2026-09-10T13:00:00.000Z' }),
      review().updatedAt
    );
  });

  it('returns conflict and not-found responses without exposing storage errors', async () => {
    expect((await route.PATCH(request('PATCH', {
      id: review().id,
      expectedUpdatedAt: review().updatedAt,
      status: 'ACTIVE',
      item: { type: 'review', originalReviewText: 'Exact' },
    }))).status).toBe(404);

    mocks.listProofRecords.mockResolvedValue([review()]);
    mocks.updateProofRecord.mockRejectedValue(new Error('Proof record changed before this update could be saved.'));
    const conflict = await route.PATCH(request('PATCH', {
      id: review().id,
      expectedUpdatedAt: review().updatedAt,
      status: 'ACTIVE',
      item: { type: 'review', originalReviewText: 'Exact' },
    }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: 'Proof record changed. Reload it and try again.',
    });
  });

  it('does not expose a permanent-delete handler', () => {
    expect('DELETE' in route).toBe(false);
  });
});
