import { getOperatorAccess, type OperatorAccess } from '@/lib/auth/server-access';

export const operatorAccessDeniedResponse = (access: Exclude<OperatorAccess, { allowed: true }>) =>
  Response.json(
    { error: access.error },
    { status: access.status, headers: { 'Cache-Control': 'private, no-store' } }
  );

export async function requireOperatorAccess(): Promise<Response | null> {
  const access = await getOperatorAccess();
  if (access.allowed) return null;
  return operatorAccessDeniedResponse(access);
}
