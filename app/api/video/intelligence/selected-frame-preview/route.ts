import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { parseGenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { isSafeMediaId } from '@/lib/media/storage';
import { getMediaStorage } from '@/lib/media/local-storage';
import { CreativeSourceHydrationError, hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { videoSourceHash } from '@/lib/video/library-service';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { extractVideoSelectionFrames, loadVideoSelectionContext } from '@/lib/video/selection-context';

export const runtime = 'nodejs';
export const maxDuration = 300;
const noStore = { 'Cache-Control': 'private, no-store' };

const parseRequest = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || !('mediaId' in body) || !('videoFrameSelection' in body)
    || typeof body.mediaId !== 'string' || !isSafeMediaId(body.mediaId)) return null;
  const selection = parseGenerateVideoFrameSelection(body.videoFrameSelection);
  return selection?.frameIds.length === 1 ? { mediaId: body.mediaId, selection } : null;
};

export async function POST(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  try {
    assertDurableVideoIntelligenceAvailable();
    const parsed = parseRequest(await request.json());
    if (!parsed) return NextResponse.json({ error: 'Choose one valid stored TRA video frame to preview.' }, { status: 400, headers: noStore });
    const [source] = await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId: parsed.mediaId, role: 'TRA_VIDEO' }]);
    const video = source as HydratedTraVideoSource;
    if (videoSourceHash(video) !== parsed.selection.sourceVideoContentHash) {
      return NextResponse.json({ error: 'The selected TRA video frame is stale. Reanalyze the video and select it again.' }, { status: 409, headers: noStore });
    }
    const context = await loadVideoSelectionContext(video);
    if (!context?.library || context.library.id !== parsed.selection.libraryId) {
      return NextResponse.json({ error: 'The selected TRA video frame library is missing or invalid. Reanalyze the video and select it again.' }, { status: 409, headers: noStore });
    }
    const selected = await extractVideoSelectionFrames(video, context, parsed.selection.frameIds);
    const frame = selected.frames[0];
    return new Response(new Uint8Array(frame.buffer), { headers: { ...noStore, 'Content-Type': 'image/png',
      'X-TRA-Frame-ID': parsed.selection.frameIds[0], 'X-TRA-Frame-Timestamp-Ms': String(frame.timestampMs),
      'X-TRA-PNG-SHA256': frame.frameSha256 } });
  } catch (error) {
    if (error instanceof CreativeSourceHydrationError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: noStore });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'The selected TRA video frame could not be verified. Select it again.' },
      { status: videoIntelligenceHttpStatus(error instanceof SyntaxError ? 400 : 409), headers: noStore });
  }
}
