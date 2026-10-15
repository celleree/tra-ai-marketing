import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { isClerkConfigured } from '@/lib/auth/server-access';
import { recoveryApiResponse } from '@/lib/recovery/read-only';

/** Keep local and unprovisioned environments free of Clerk's keyless setup. */
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const recovery = recoveryApiResponse(request);
  if (recovery) return recovery;
  if (!isClerkConfigured()) return NextResponse.next();
  return clerkMiddleware()(request, event);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};
