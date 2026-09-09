import { isDeploymentRuntimeConsistent } from '@/lib/runtime/deployment';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { isAllowedTraOperator } from '@/lib/auth/operators';

export type OperatorAccess =
  | { allowed: true; userId: string }
  | { allowed: false; status: 401 | 403 | 503; error: string };

/** Check before invoking Clerk so missing configuration cannot start keyless setup. */
export const isClerkConfigured = (): boolean => Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim()
  && process.env.CLERK_SECRET_KEY?.trim(),
);

/** Server resource boundary: identity comes from Clerk, never request data. */
export async function getOperatorAccess(): Promise<OperatorAccess> {
  const unavailable = { allowed: false, status: 503, error: 'Authentication is unavailable.' } as const;
  if (!isDeploymentRuntimeConsistent() || !isClerkConfigured()) return unavailable;

  try {
    const { userId } = await auth({ acceptsToken: 'session_token' });
    if (!userId) return { allowed: false, status: 401, error: 'Sign in required.' };

    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    if (!isAllowedTraOperator(user)) {
      return { allowed: false, status: 403, error: 'Operator access required.' };
    }
    return { allowed: true, userId };
  } catch {
    return unavailable;
  }
}
