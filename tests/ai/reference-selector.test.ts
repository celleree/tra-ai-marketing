import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getMediaStorage = vi.hoisted(() => vi.fn());

vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage }));

import { selectBestReferenceCreatives } from '@/lib/ai/reference-selector';
import { MediaValidationError } from '@/lib/media/storage';

const id = `media_${'a'.repeat(32)}`;
const candidate = {
  item: {
    id,
    fileName: `${id}.png`,
    originalName: 'reference.png',
    mimeType: 'image/png' as const,
    size: 12,
    url: `/api/media/files/${id}.png`,
    addedAt: '2026-01-01T00:00:00.000Z',
    referenceType: 'layout' as const,
    angle: 'customer-problems' as const,
    angleSource: 'manual' as const,
  },
  imageUrl: `http://localhost/api/media/files/${id}.png`,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reference-library analysis input validation', () => {
  it('rejects malformed stored reference pixels before sending them for analysis', async () => {
    getMediaStorage.mockReturnValue({
      readImageById: vi.fn(async () => ({
        fileName: `${id}.png`,
        buffer: Buffer.from('not a png'),
        mimeType: 'image/png' as const,
      })),
    });

    await expect(
      selectBestReferenceCreatives({
        candidates: [candidate],
        requestedCount: 1,
        userContext: 'Create a clear TRA ad.',
        traSummary: 'TRA source summary',
        traPreserve: ['TRA identity'],
      })
    ).rejects.toBeInstanceOf(MediaValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
