import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOperatorAccess: vi.fn(),
  getMediaStorage: vi.fn(),
}));

vi.mock('@/lib/auth/server-access', () => ({
  getOperatorAccess: mocks.getOperatorAccess,
}));
vi.mock('@/lib/media/local-storage', () => ({
  getMediaStorage: mocks.getMediaStorage,
}));

import { POST as generate } from '@/app/api/creatives/generate/route';
import { POST as revise } from '@/app/api/creatives/[creativeId]/revise/route';

const deniedRequest = { json: vi.fn() } as unknown as Request;
let revisionParamsRead = 0;
const deniedRevisionContext = {
  get params() {
    revisionParamsRead += 1;
    return Promise.resolve({ creativeId: `creative_${'a'.repeat(32)}` });
  },
} as unknown as { params: Promise<{ creativeId: string }> };

const guardedRoutes = [
  ['generate', () => generate(deniedRequest)],
  ['revise', () => revise(deniedRequest, deniedRevisionContext)],
] as const;

describe('creative generation operator guards', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    revisionParamsRead = 0;
  });

  it.each([
    [401, 'Sign in required.'],
    [403, 'Operator access required.'],
    [503, 'Authentication is unavailable.'],
  ].flatMap(([status, error]) =>
    guardedRoutes.map(([route, invoke]) => [status, route, invoke, error] as const)
  ))('returns %i from %s before route inputs or generation work', async (status, _route, invoke, error) => {
    mocks.getOperatorAccess.mockResolvedValue({ allowed: false, status, error });

    const response = await invoke();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(deniedRequest.json).not.toHaveBeenCalled();
    expect(revisionParamsRead).toBe(0);
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
  });
});
