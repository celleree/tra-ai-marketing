import { NextResponse } from 'next/server';
import { getMediaStorage } from '@/lib/media/local-storage';
import { isSafeMediaId } from '@/lib/media/storage';
import { CreativeSourceHydrationError, hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import { selectVideoFramesForConcept } from '@/lib/video/concept-selection';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { assertLocalVideoIntelligence, loadVideoFrameLibrary, videoSourceHash } from '@/lib/video/library-service';

export const runtime = 'nodejs';

const errorResponse = (error: unknown) => NextResponse.json(
  { error: error instanceof Error ? error.message : 'Video frame selection failed.' },
  { status: process.env.NODE_ENV === 'production' ? 404 : error instanceof CreativeSourceHydrationError ? error.status : 500 }
);

export async function POST(request: Request) {
  try {
    assertLocalVideoIntelligence();
    const body = await request.json() as { mediaId?: unknown; concept?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    if (typeof body.mediaId !== 'string' || !isSafeMediaId(body.mediaId)) {
      return NextResponse.json({ error: 'Choose a stored TRA video.' }, { status: 400 });
    }
    if (typeof body.concept !== 'string' || !body.concept.trim() || body.concept.trim().length > 2_000) {
      return NextResponse.json({ error: 'Video concept must be between 1 and 2000 characters.' }, { status: 400 });
    }
    const [source] = await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId: body.mediaId, role: 'TRA_VIDEO' }]);
    const video = source as HydratedTraVideoSource;
    const library = await loadVideoFrameLibrary(video.media.id, videoSourceHash(video));
    if (!library) return NextResponse.json({ error: 'Analyze this video before selecting frames.' }, { status: 409 });
    return NextResponse.json({ selection: await selectVideoFramesForConcept(library, body.concept) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    return errorResponse(error);
  }
}
