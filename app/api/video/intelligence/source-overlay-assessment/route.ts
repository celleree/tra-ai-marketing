import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { getMediaStorage } from '@/lib/media/local-storage';
import { hydrateCreativeSourceSelections, CreativeSourceHydrationError } from '@/lib/media/source-hydration';
import { isSafeMediaId } from '@/lib/media/storage';
import { parseGenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { isSuitableVideoHumanFrameAssessment } from '@/lib/video/human-frame-selection';
import { videoSourceHash } from '@/lib/video/library-service';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { preflightVideoHumanFrameFromPoolWithCache, selectVideoHumanFrameFromPoolWithCache } from '@/lib/video/selection-cache';
import { loadVideoSelectionContext } from '@/lib/video/selection-context';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';

export const runtime = 'nodejs';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'private, no-store' };
const concept = 'Assess TRA human source pixels for captions, lower thirds, logos, watermarks, and portrait suitability.';

export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    assertDurableVideoIntelligenceAvailable();
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Choose a source frame to assess.' }, { status: 400, headers });
    const input = body as Record<string, unknown>;
    const selection = parseGenerateVideoFrameSelection(input.videoFrameSelection);
    if (!(Object.keys(input).length === 2 || (Object.keys(input).length === 3 && 'retry' in input))
      || (input.retry !== undefined && typeof input.retry !== 'boolean')
      || typeof input.mediaId !== 'string' || !isSafeMediaId(input.mediaId) || !selection) {
      return NextResponse.json({ error: 'Choose a valid stored TRA video frame selection.' }, { status: 400, headers });
    }
    const [source] = await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId: input.mediaId, role: 'TRA_VIDEO' }]);
    const video = source as HydratedTraVideoSource;
    const context = await loadVideoSelectionContext(video);
    if (videoSourceHash(video) !== selection.sourceVideoContentHash || !context?.representativeImages || !context.librarySha256
      || context.library.id !== selection.libraryId || selection.frameIds.some(id => !context.library.representativeFrames.some(frame => frame.id === id))) {
      return NextResponse.json({ error: 'The selected frames lack current source-bound visual preparation. Reanalyze the video.' }, { status: 409, headers });
    }
    const bindings = [{ library: context.library, librarySha256: context.librarySha256, representativeImages: context.representativeImages }];
    const reuse = { version: 1 as const, frames: [] };
    const cache = { model: process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra', deadlineAtMs: Date.now() + 295_000,
      retry: input.retry === true };
    const preflight = await preflightVideoHumanFrameFromPoolWithCache(bindings, concept, reuse, cache);
    if (preflight.status === 'READY') {
      const denied = await requireOperatorQuota(access.userId, 'VIDEO_SELECTION', 1);
      if (denied) return denied;
    }
    const result = preflight.status === 'COMPLETE' ? preflight
      : await selectVideoHumanFrameFromPoolWithCache(bindings, concept, reuse, cache);
    if (result.status !== 'COMPLETE') return NextResponse.json({
      error: result.status === 'BUSY' ? 'Visual source assessment is still in progress. Check again later.'
        : 'Visual source assessment needs an explicit retry before these frames can be used.',
      retryRequired: result.status === 'RETRY_REQUIRED',
    }, { status: 409, headers });
    const decisions = selection.frameIds.map(frameId => result.outcome.assessments.find(item => item.libraryId === selection.libraryId && item.frameId === frameId));
    if (decisions.some(item => !item || !isSuitableVideoHumanFrameAssessment(item))) {
      return NextResponse.json({ error: 'A selected frame is unsuitable or contains an unsafe source overlay. Choose and reassess another frame.' }, { status: 409, headers });
    }
    const assessed = parseGenerateVideoFrameSelection({ version: 2, libraryId: selection.libraryId,
      sourceVideoContentHash: selection.sourceVideoContentHash, frameIds: selection.frameIds,
      sourceOverlays: decisions.map(item => item!.sourceOverlay) });
    if (!assessed) throw new Error('Source overlay assessment could not be bound to the selected frames.');
    return NextResponse.json({ videoFrameSelection: assessed }, { headers });
  } catch (error) {
    const status = error instanceof CreativeSourceHydrationError ? error.status : error instanceof SyntaxError ? 400 : 409;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Source overlay assessment failed.' },
      { status: videoIntelligenceHttpStatus(status), headers });
  }
}
