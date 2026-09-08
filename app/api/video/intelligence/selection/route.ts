import { NextResponse } from 'next/server';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { resolveExistingVideoIntelligenceJob, VideoIntelligenceServiceError } from '@/lib/video/intelligence-service';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { selectVideoFramesWithCache } from '@/lib/video/selection-cache';

export const runtime = 'nodejs';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  const deadlineAtMs = Date.now() + 295_000;
  try {
    assertDurableVideoIntelligenceAvailable();
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.concept !== 'string'
      || !body.concept.trim() || body.concept.trim().length > 2_000
      || (body.retry !== undefined && typeof body.retry !== 'boolean')) {
      throw new VideoIntelligenceServiceError('Choose a concept between 1 and 2000 characters and an explicit retry option.', 400);
    }
    const { identity, job } = await resolveExistingVideoIntelligenceJob(body.locator, {});
    if (job.phase !== 'COMPLETE') throw new VideoIntelligenceServiceError('Analyze this video before selecting frames.', 409);
    const library = await loadVideoIntelligenceLibrary(identity, job.result!);
    const result = await selectVideoFramesWithCache(library, job.result!.sha256, body.concept, {
      model: identity.analyzerFingerprint.visionModel, deadlineAtMs, retry: body.retry === true,
    });
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Video selection failed.' }, {
      headers, status: videoIntelligenceHttpStatus(error instanceof VideoIntelligenceServiceError ? error.status
        : error instanceof SyntaxError ? 400 : 500),
    });
  }
}
