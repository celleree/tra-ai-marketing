import { getOperatorAccess } from '@/lib/auth/server-access';

export async function requireOperatorAccess(): Promise<Response | null> {
  const access = await getOperatorAccess();
  if (access.allowed) return null;

  return Response.json(
    { error: access.error },
    {
      status: access.status,
      headers: { 'Cache-Control': 'private, no-store' },
    }
  );
}
