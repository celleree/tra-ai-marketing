import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPausedMetaAd,
  createPausedMetaAdSet,
  createPausedMetaCampaign,
} from '@/lib/meta/client';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('META_ACCESS_TOKEN', 'test-token');
  vi.stubEnv('META_GRAPH_API_VERSION', 'v25.0');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ id: '9001' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const expectPausedPost = (edge: string) => {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0];
  expect(String(input)).toBe(`https://graph.facebook.com/v25.0/${edge}`);
  expect(init?.method).toBe('POST');
  expect(init?.body).toBeInstanceOf(URLSearchParams);
  expect((init?.body as URLSearchParams).get('status')).toBe('PAUSED');
};

describe('Meta creation safety', () => {
  it('submits new campaigns with status=PAUSED', async () => {
    await expect(
      createPausedMetaCampaign({ adAccountId: '123', name: 'Campaign' })
    ).resolves.toBe('9001');

    expectPausedPost('act_123/campaigns');
  });

  it('submits new ad sets with status=PAUSED', async () => {
    await expect(
      createPausedMetaAdSet({
        adAccountId: '123',
        campaignId: '456',
        name: 'Ad set',
        dailyBudgetCents: 500,
      })
    ).resolves.toBe('9001');

    expectPausedPost('act_123/adsets');
  });

  it('submits new ads with status=PAUSED', async () => {
    await expect(
      createPausedMetaAd({
        adAccountId: '123',
        adSetId: '456',
        creativeId: '789',
        name: 'Ad',
      })
    ).resolves.toBe('9001');

    expectPausedPost('act_123/ads');
  });
});
