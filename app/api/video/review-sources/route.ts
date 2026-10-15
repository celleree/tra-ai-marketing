import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { record, ReviewSelectionError } from '@/lib/video/review-selection';
import { discoverReviewStatements } from '@/lib/video/review-statement-discovery';
import { VideoIntelligenceServiceError } from '@/lib/video/intelligence-service';
import { CreativeSourceHydrationError } from '@/lib/media/source-hydration';
import { MAX_REVIEW_PREVIEW_BATCH } from '@/lib/video/review-preview-policy';
import { discoverVideoReviewSource } from '@/lib/video/review-source-discovery';

export const runtime = 'nodejs';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'private, no-store' };
/** Read-only discovery of existing Proof fields and the supplied operator Profile snapshot. */
export async function POST(request: Request) {
  const denied = await requireOperatorAccess(); if (denied) return denied;
  try {
    assertDurableVideoIntelligenceAvailable();
    const body: unknown = await request.json();
    if (!record(body) || Object.keys(body).length !== 1 || !('companyProfile' in body)) throw new ReviewSelectionError('Statement sources are invalid.', 400);
    return NextResponse.json(await discoverReviewStatements(body.companyProfile), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ReviewSelectionError ? error.message : 'Statement sources could not be loaded.' },
      { headers, status: videoIntelligenceHttpStatus(error instanceof ReviewSelectionError ? error.status : error instanceof SyntaxError ? 400 : 503) });
  }
}
export async function GET(request: Request) {
  const denied = await requireOperatorAccess(); if (denied) return denied;
  try {
    assertDurableVideoIntelligenceAvailable();
    const query = new URL(request.url).searchParams;
    const candidate = query.get('candidateIndex'), batch = query.get('candidateIndexes');
    const values = batch === null ? [] : batch.split(',');
    if ((candidate !== null && (batch !== null || !/^\d+$/.test(candidate)))
      || (batch !== null && (values.length > MAX_REVIEW_PREVIEW_BATCH || values.some(value => !/^\d+$/.test(value))))) {
      throw new ReviewSelectionError('Preview candidate batch is invalid.', 400);
    }
    const result = await discoverVideoReviewSource(query.get('mediaId') ?? '',
      batch !== null ? values.map(Number) : candidate === null ? undefined : Number(candidate));
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
