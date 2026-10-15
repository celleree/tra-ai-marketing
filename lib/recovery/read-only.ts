const message = 'Read-only recovery: saved work is preserved. Editing and generation are paused.';

export const isReadOnlyRecovery = () => process.env.TRA_RECOVERY_READ_ONLY === 'true';

/** These GET handlers only read saved records/media and retain operator checks. */
export function isRecoveryReadAllowed(method: string, pathname: string) {
  return ['GET', 'HEAD'].includes(method.toUpperCase()) && (
    pathname === '/api/creatives'
    || /^\/api\/media\/files\/media_[a-f0-9]{32}\.(png|jpg|jpeg|webp|mp4)$/.test(pathname)
  );
}

export function recoveryApiResponse(request: { method: string; nextUrl: { pathname: string } }) {
  if (!isReadOnlyRecovery() || !/^\/(api|trpc)(\/|$)/.test(request.nextUrl.pathname)
    || isRecoveryReadAllowed(request.method, request.nextUrl.pathname)) return null;
  return Response.json({ error: message }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
}

export function assertRecoveryWritable() {
  if (isReadOnlyRecovery()) throw new Error(message);
}

/** Display projection only. No new-schema metadata is decoded or written back. */
export function recoveryDisplayRecord(value: unknown): unknown {
  if (!isReadOnlyRecovery() || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { planning, generationProvenance, videoFrameSelection, ...display } = value as Record<string, unknown>;
  return display;
}
