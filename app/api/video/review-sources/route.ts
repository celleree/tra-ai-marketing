import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { ReviewSelectionError } from '@/lib/video/review-selection';
import { VideoIntelligenceServiceError } from '@/lib/video/intelligence-service';
import { CreativeSourceHydrationError } from '@/lib/media/source-hydration';
import { discoverVideoReviewSource } from '@/lib/video/review-source-discovery';

export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  const denied = await requireOperatorAccess(); if (denied) return denied;
  try {
    assertDurableVideoIntelligenceAvailable();
    const query = new URL(request.url).searchParams;
    const candidate = query.get('candidateIndex');
    if (candidate !== null && !/^\d+$/.test(candidate)) throw new ReviewSelectionError('Preview candidate index is invalid.', 400);
    const result = await discoverVideoReviewSource(query.get('mediaId') ?? '', candidate === null ? undefined : Number(candidate));
    // Completed libraries can exceed the platform's buffered response limit.
    const bytes = new TextEncoder().encode(JSON.stringify(result));
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }), { headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch (error) {
    const status = error instanceof ReviewSelectionError || error instanceof VideoIntelligenceServiceError || error instanceof CreativeSourceHydrationError
      ? error.status : 409;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Video review source is unavailable.' },
      { headers, status: videoIntelligenceHttpStatus(status) });
  }
}
