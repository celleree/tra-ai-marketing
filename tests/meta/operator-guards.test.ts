import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOperatorAccess: vi.fn(),
  listMetaAdAccounts: vi.fn(), listMetaAdSets: vi.fn(), listMetaCampaigns: vi.fn(),
  listMetaPages: vi.fn(), listMetaPromotablePages: vi.fn(),
  createPausedMetaCampaign: vi.fn(), createPausedMetaAdSet: vi.fn(), uploadMetaAdImage: vi.fn(),
  createMetaAdCreative: vi.fn(), createPausedMetaAd: vi.fn(),
}));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/meta/client', () => ({ ...mocks, MetaApiError: class extends Error {} }));

import { GET as adAccounts } from '@/app/api/meta/ad-accounts/route';
import { GET as adSets } from '@/app/api/meta/ad-sets/route';
import { GET as campaigns } from '@/app/api/meta/campaigns/route';
import { GET as pages } from '@/app/api/meta/pages/route';
import { POST as publish } from '@/app/api/meta/publish/route';

const deniedRequest = { json: vi.fn() } as unknown as Request;
const guardedRoutes = [
  ['ad accounts', () => adAccounts()],
  ['ad sets', () => adSets(deniedRequest)],
  ['campaigns', () => campaigns(deniedRequest)],
  ['pages', () => pages(deniedRequest)],
  ['publish', () => publish(deniedRequest)],
] as const;

describe('Meta operator guards', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([401, 403, 503].flatMap((status) =>
    guardedRoutes.map(([route, invoke]) => [status, route, invoke] as const)
  ))('returns %i from %s before inputs or Meta client work', async (status, _route, invoke) => {
    mocks.getOperatorAccess.mockResolvedValue({ allowed: false, status, error: 'Access denied.' });

    expect((await invoke()).status).toBe(status);
    expect(mocks.getOperatorAccess).toHaveBeenCalledTimes(1);
    expect(deniedRequest.json).not.toHaveBeenCalled();
    for (const call of Object.values(mocks).filter(call => call !== mocks.getOperatorAccess)) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});
