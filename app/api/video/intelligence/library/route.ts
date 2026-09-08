import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { loadVideoIntelligenceLibrary, MAX_VIDEO_INTELLIGENCE_LIBRARY_BYTES } from '@/lib/video/intelligence-finalization-runner';
import { resolveExistingVideoIntelligenceJob, VideoIntelligenceServiceError } from '@/lib/video/intelligence-service';

export const runtime = 'nodejs';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  try {
    assertDurableVideoIntelligenceAvailable();
    const body = await request.json();
    const { identity, job } = await resolveExistingVideoIntelligenceJob(body?.locator, {});
    if (job.phase !== 'COMPLETE') throw new VideoIntelligenceServiceError('Video analysis is not complete.', 409);
    const library = await loadVideoIntelligenceLibrary(identity, job.result!);
    const bytes = new TextEncoder().encode(JSON.stringify(library));
    if (bytes.length > MAX_VIDEO_INTELLIGENCE_LIBRARY_BYTES) throw new Error('Video library exceeds the response limit.');
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) { controller.close(); return; }
        const end = Math.min(offset + 64 * 1024, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    }), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Video library could not be loaded.' }, {
      headers, status: videoIntelligenceHttpStatus(error instanceof VideoIntelligenceServiceError ? error.status
        : error instanceof SyntaxError ? 400 : 500),
    });
  }
}
