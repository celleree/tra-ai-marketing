import { getMediaStorage } from '@/lib/media/local-storage';
import { createVideoResponse } from '@/lib/media/video-response';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ fileName: string }> }
) {
  const { fileName } = await context.params;
  const stored = await getMediaStorage().readMedia(fileName);

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
