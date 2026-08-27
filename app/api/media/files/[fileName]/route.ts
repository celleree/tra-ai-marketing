import { getMediaStorage } from '@/lib/media/local-storage';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileName: string }> }
) {
  const { fileName } = await context.params;
  const stored = await getMediaStorage().readMedia(fileName);

  if (!stored) {
    return new Response('Not found', { status: 404 });
  }

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
