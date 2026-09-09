import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getMediaStorage = vi.hoisted(() => vi.fn());

vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage }));

import {
  selectBestReferenceCreatives,
  type ReferenceSelectionCandidate,
} from '@/lib/ai/reference-selector';
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

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9ywAAAABJRU5ErkJggg==',
  'base64'
);

const makeCandidate = (
  index: number,
  angle = 'customer-problems',
  addedAt = new Date(Date.UTC(2026, 0, 1, index)).toISOString()
): ReferenceSelectionCandidate => {
  const candidateId = `media_${String(index).padStart(32, '0')}`;
  return {
    item: {
      ...candidate.item,
      id: candidateId,
      fileName: `${candidateId}.png`,
      url: `/api/media/files/${candidateId}.png`,
      addedAt,
      angle: angle as ReferenceSelectionCandidate['item']['angle'],
    },
    imageUrl: `http://localhost/api/media/files/${candidateId}.png`,
  };
};

const makeCandidateArray = (count: number) =>
  Array.from({ length: count }, (_, index) => makeCandidate(index + 1));

const selectionArgs = (
  candidates: ReferenceSelectionCandidate[],
  requestedCount: number
) => ({
  candidates,
  requestedCount,
  userContext: 'Create a clear TRA ad.',
  traSummary: 'TRA source summary',
  traPreserve: ['TRA identity'],
});

const responseWithSelections = (referenceIds: string[]) =>
  new Response(
    JSON.stringify({
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                selections: referenceIds.map((referenceId) => ({
                  referenceId,
                  reason: `Selected ${referenceId}`,
                })),
              }),
            },
          ],
        },
      ],
    }),
    { status: 200 }
  );

const sentReferenceIds = (fetchMock: ReturnType<typeof vi.fn>) => {
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
  const body = JSON.parse(String(request.body)) as {
    input: Array<{ content: Array<{ type: string; text?: string }> }>;
  };
  return body.input[1].content
    .filter(
      (part) =>
        part.type === 'input_text' && part.text?.startsWith('REFERENCE ID: ')
    )
    .map((part) => part.text?.match(/^REFERENCE ID: (.+)$/m)?.[1]);
};

let fetchMock: ReturnType<typeof vi.fn>;
let originalApiKey: string | undefined;

beforeEach(() => {
  originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  getMediaStorage.mockReturnValue({
    readImageById: vi.fn(async () => ({
      fileName: `${id}.png`,
      buffer: validPng,
      mimeType: 'image/png' as const,
    })),
  });
  fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      input: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const requestedCount = Number(
      body.input[1].content[0]?.text?.match(/Choose exactly (\d+)/)?.[1]
    );
    const referenceIds = body.input[1].content
      .filter(
        (part) =>
          part.type === 'input_text' && part.text?.startsWith('REFERENCE ID: ')
      )
      .map((part) => part.text?.match(/^REFERENCE ID: (.+)$/m)?.[1])
      .filter((referenceId): referenceId is string => Boolean(referenceId));
    return responseWithSelections(referenceIds.slice(0, requestedCount));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
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

describe('reference selection candidate budgeting', () => {
  it.each([
    [1, 8],
    [2, 8],
    [3, 12],
    [5, 20],
    [10, 40],
    [20, 40],
  ])(
    'uses %i requested creatives and a %i-candidate budget when enough are available',
    async (requestedCount, expectedCandidateCount) => {
      await selectBestReferenceCreatives(
        selectionArgs(makeCandidateArray(50), requestedCount)
      );

      expect(sentReferenceIds(fetchMock)).toHaveLength(expectedCandidateCount);
    }
  );

  it('preserves all available candidates when fewer than the budget exist', async () => {
    const candidates = makeCandidateArray(6);

    await selectBestReferenceCreatives(selectionArgs(candidates, 1));

    expect(sentReferenceIds(fetchMock)).toEqual(candidates.map((item) => item.item.id));
  });

  it('preserves angle round-robin and newest-first candidate ordering', async () => {
    const candidates = [
      makeCandidate(1, 'angle-a', '2026-01-02T00:00:00.000Z'),
      makeCandidate(2, 'angle-b', '2026-01-02T00:00:00.000Z'),
      makeCandidate(3, 'angle-a', '2026-01-04T00:00:00.000Z'),
      makeCandidate(4, 'angle-b', '2026-01-05T00:00:00.000Z'),
      makeCandidate(5, 'angle-a', '2026-01-03T00:00:00.000Z'),
      makeCandidate(6, 'angle-b', '2026-01-03T00:00:00.000Z'),
      makeCandidate(7, 'angle-a', '2026-01-01T00:00:00.000Z'),
      makeCandidate(8, 'angle-b', '2026-01-01T00:00:00.000Z'),
      makeCandidate(9, 'angle-a', '2025-12-31T00:00:00.000Z'),
      makeCandidate(10, 'angle-b', '2025-12-31T00:00:00.000Z'),
    ];

    await selectBestReferenceCreatives(selectionArgs(candidates, 1));

    expect(sentReferenceIds(fetchMock)).toEqual(
      [3, 4, 5, 6, 1, 2, 7, 8].map((index) => candidates[index - 1].item.id)
    );
  });

  it('returns model selections in response order and removes duplicates', async () => {
    const candidates = makeCandidateArray(12);
    fetchMock.mockResolvedValueOnce(
      responseWithSelections([
        candidates[3].item.id,
        candidates[0].item.id,
        candidates[3].item.id,
        candidates[2].item.id,
      ])
    );

    const selected = await selectBestReferenceCreatives(
      selectionArgs(candidates, 3)
    );

    expect(selected.map((item) => item.item.id)).toEqual([
      candidates[3].item.id,
      candidates[0].item.id,
      candidates[2].item.id,
    ]);
  });
});
