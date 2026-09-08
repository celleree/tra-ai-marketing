import { beforeEach, describe, expect, it, vi } from 'vitest';

const reserveOperatorQuota = vi.hoisted(() => vi.fn());
vi.mock('@/lib/quotas/operator-quota', () => ({
  OperatorQuotaUnavailableError: class OperatorQuotaUnavailableError extends Error {},
  reserveOperatorQuota,
}));
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { OperatorQuotaUnavailableError } from '@/lib/quotas/operator-quota';

describe('quota response adapter', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns a private 429 with Retry-After when an operator is over quota', async () => {
    reserveOperatorQuota.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const response = await requireOperatorQuota('operator', 'CREATIVE_GENERATION', 2);
    expect(response).toMatchObject({ status: 429 });
    expect(response!.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response!.headers.get('Retry-After')).toBe('42');
    await expect(response!.json()).resolves.toEqual({ error: 'Quota exceeded. Try again later.' });
  });

  it('fails closed with a private 503 when durable quota state is unavailable', async () => {
    reserveOperatorQuota.mockRejectedValue(new OperatorQuotaUnavailableError());
    const response = await requireOperatorQuota('operator', 'CREATIVE_REVISION', 1);
    expect(response).toMatchObject({ status: 503 });
    expect(response!.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response!.json()).resolves.toEqual({ error: 'Quota service is unavailable.' });
  });
});
