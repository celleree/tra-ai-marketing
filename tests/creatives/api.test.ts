import { describe, expect, it, vi } from 'vitest';

const { getMediaStorageMock, saveCreativeBatchMock } = vi.hoisted(() => ({
  getMediaStorageMock: vi.fn(),
  saveCreativeBatchMock: vi.fn(),
}));

vi.mock('@/lib/creatives/storage', () => ({
  isSafeCreativeId: (value: string) => /^creative_[a-f0-9]{32}$/.test(value),
  listCreatives: vi.fn(),
  saveCreativeBatch: saveCreativeBatchMock,
}));

vi.mock('@/lib/creatives/attribution', () => ({
  getCreativeAttribution: vi.fn(),
}));

vi.mock('@/lib/media/local-storage', () => ({
  getMediaStorage: getMediaStorageMock,
}));

import { POST } from '@/app/api/creatives/route';

const request = (body: string) =>
  new Request('http://localhost/api/creatives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

describe('TRA creatives API validation', () => {
  it.each([
    ['malformed JSON', '{'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"invalid"'],
    ['a missing creatives property', '{}'],
    ['a non-array creatives property', '{"creatives":null}'],
  ])('returns 400 for %s', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(saveCreativeBatchMock).not.toHaveBeenCalled();
    expect(getMediaStorageMock).not.toHaveBeenCalled();
  });
});
