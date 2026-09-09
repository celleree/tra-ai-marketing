import { beforeEach, describe, expect, it, vi } from 'vitest';

const getOperatorAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess }));
import { requireOperatorAccess } from '@/lib/auth/require-operator';

describe('requireOperatorAccess', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns null for an authorized operator', async () => {
    getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' });
    await expect(requireOperatorAccess()).resolves.toBeNull();
  });

  it.each([
    [401, 'Sign in required.'],
    [403, 'Operator access required.'],
    [503, 'Authentication is unavailable.'],
  ])('maps denied access to a private %i response', async (status, error) => {
    getOperatorAccess.mockResolvedValue({ allowed: false, status, error });
    const response = await requireOperatorAccess();
    expect(response).toMatchObject({ status });
    expect(response!.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response!.json()).resolves.toEqual({ error });
  });
});
