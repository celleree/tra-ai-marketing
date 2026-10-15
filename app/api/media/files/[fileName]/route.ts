import { getMediaStorage } from '@/lib/media/local-storage';
import { createVideoResponse } from '@/lib/media/video-response';
import { requireOperatorAccess } from '@/lib/auth/require-operator';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ fileName: string }> }
) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  const { fileName } = await context.params;
  const mediaStorage = getMediaStorage();

  if (mediaStorage.getMediaDeliveryUrl) {
    const deliveryUrl = await mediaStorage.getMediaDeliveryUrl(fileName);
    if (!deliveryUrl) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(null, {
      status: 307,
      headers: {
        Location: deliveryUrl,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const stored = await mediaStorage.readMedia(fileName);

  if (!stored) {
    return new Response('Not found', { status: 404 });
  }

  if (stored.mimeType === 'video/mp4') return createVideoResponse(stored.buffer, request);

  return new Response(new Uint8Array(stored.buffer), {
    status: 200,
    headers: {
      'Content-Type': stored.mimeType,
      'Content-Length': String(stored.buffer.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
