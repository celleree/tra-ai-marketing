import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { getMediaStorage } from '@/lib/media/local-storage';
import { isSafeMediaId } from '@/lib/media/storage';
import { CreativeSourceHydrationError, hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { analyzeTraVideoIntelligence, assertLocalVideoIntelligence, loadVideoFrameLibrary, videoSourceHash } from '@/lib/video/library-service';

export const runtime = 'nodejs';
export const maxDuration = 300;
const hydrateSource = async (mediaId: unknown) => {
  assertLocalVideoIntelligence();
  if (typeof mediaId !== 'string' || !isSafeMediaId(mediaId)) throw new CreativeSourceHydrationError('Choose a stored TRA video.', 400);
  const sources = await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId, role: 'TRA_VIDEO' }]);
  return sources[0] as HydratedTraVideoSource;
};
const errorResponse = (error: unknown) => NextResponse.json(
  { error: error instanceof Error ? error.message : 'Video intelligence failed.' },
  { status: process.env.NODE_ENV === 'production' ? 404 : error instanceof CreativeSourceHydrationError ? error.status : error instanceof SyntaxError ? 400 : 500 }
);

export async function GET(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  try {
    const source = await hydrateSource(new URL(request.url).searchParams.get('mediaId'));
    const library = await loadVideoFrameLibrary(source.media.id, videoSourceHash(source));
    return NextResponse.json({ source: source.media, library }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  try {
    assertLocalVideoIntelligence();
    const body = await request.json();
    const source = await hydrateSource(body?.mediaId);
    const encoder = new TextEncoder();
    let connected = true;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (value: object) => { if (connected) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); };
        try {
          const result = await analyzeTraVideoIntelligence(source, { force: body.force === true,
            onProgress: (message) => send({ type: 'progress', message }) });
          send({ type: 'complete', ...result, source: source.media });
        } catch (error) { send({ type: 'error', error: error instanceof Error ? error.message : 'Video analysis failed.' }); }
        finally { if (connected) { connected = false; controller.close(); } }
      },
      // Finish and save already-started analysis if navigation disconnects the UI.
      cancel() { connected = false; },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
