import { OperatorQuotaUnavailableError, reserveOperatorQuota, type OperatorQuotaGroup } from '@/lib/quotas/operator-quota';

export async function requireOperatorQuota(
  operatorId: string,
  group: OperatorQuotaGroup,
  units: number,
): Promise<Response | null> {
  try {
    const reservation = await reserveOperatorQuota({ operatorId, group, units });
    if (reservation.allowed) return null;
    return Response.json({ error: 'Quota exceeded. Try again later.' }, {
      status: 429,
      headers: { 'Cache-Control': 'private, no-store', 'Retry-After': String(reservation.retryAfterSeconds) },
    });
  } catch (error) {
    if (error instanceof OperatorQuotaUnavailableError) {
      return Response.json({ error: 'Quota service is unavailable.' }, {
        status: 503, headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    throw error;
  }
}
