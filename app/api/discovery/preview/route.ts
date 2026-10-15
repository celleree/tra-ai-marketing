import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { loadSession } from '@/lib/discovery/storage';
import { assertProviderAvailable } from '@/lib/discovery/provider';
import { downloadSelectedImage } from '@/lib/discovery/media';
import { fingerprintImage } from '@/lib/discovery/fingerprint';
import { saveSession } from '@/lib/discovery/storage';
export const runtime = 'nodejs';
export const maxDuration = 30;
export async function GET(request: Request) {
  const access = await getOperatorAccess(); if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const query = new URL(request.url).searchParams;
    const { session, etag } = await loadSession(access.userId, query.get('session') ?? '');
    const candidate = session.candidates.find(item => item.id === query.get('candidate'));
    if (!candidate || session.sample) return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    assertProviderAvailable();
    const file = await downloadSelectedImage(candidate.imageUrl);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!session.fingerprints?.[candidate.id]) {
      session.fingerprints = { ...session.fingerprints, [candidate.id]: await fingerprintImage(bytes) };
      await saveSession(access.userId, session, etag).catch(() => {}); // A competing operator action wins; preview remains readable.
    }
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': file.type, 'Content-Length': String(file.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
  } catch {
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
