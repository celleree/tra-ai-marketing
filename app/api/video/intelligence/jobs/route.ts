import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse, requireOperatorAccess } from '@/lib/auth/require-operator';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { isSafeMediaId } from '@/lib/media/storage';
import { CreativeSourceHydrationError } from '@/lib/media/source-hydration';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import {
  executeVideoIntelligenceStep, readVideoIntelligenceSource, resolveVideoIntelligenceJobLocator, VideoIntelligenceServiceError,
  type ExecuteVideoIntelligenceStepInput,
} from '@/lib/video/intelligence-service';

export const runtime = 'nodejs';
export const maxDuration = 300;
const RESPONSE_RESERVE_MS = 5_000;
const headers = { 'Cache-Control': 'no-store' };
const errorResponse = (error: unknown) => NextResponse.json({
  error: error instanceof Error ? error.message : 'Video intelligence failed.',
}, { headers, status: videoIntelligenceHttpStatus(
  error instanceof VideoIntelligenceServiceError || error instanceof CreativeSourceHydrationError ? error.status
    : error instanceof SyntaxError ? 400 : 500) });

export async function GET(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  const deadlineAtMs = Date.now() + maxDuration * 1_000 - RESPONSE_RESERVE_MS;
  try {
    assertDurableVideoIntelligenceAvailable();
    const mediaId = new URL(request.url).searchParams.get('mediaId') ?? '';
    return NextResponse.json(await readVideoIntelligenceSource(mediaId, { deadlineAtMs }), { headers });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  const deadlineAtMs = Date.now() + maxDuration * 1_000 - RESPONSE_RESERVE_MS;
  try {
    assertDurableVideoIntelligenceAvailable();
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new VideoIntelligenceServiceError('Invalid video job request.', 400);
    }
    const value = body as Record<string, unknown>;
    let input: ExecuteVideoIntelligenceStepInput;
    if (value.action === 'START' && typeof value.mediaId === 'string') {
      input = { action: 'START', mediaId: value.mediaId };
    } else if (value.action === 'STATUS' || value.action === 'ADVANCE' || value.action === 'RETRY') {
      // The service validates the locator and reconstructs current server settings.
      input = { action: value.action, locator: value.locator as Extract<ExecuteVideoIntelligenceStepInput, { locator: unknown }>['locator'] };
    } else throw new VideoIntelligenceServiceError('Invalid video job action.', 400);
    if (input.action !== 'STATUS') {
      if (input.action === 'START') {
        if (!isSafeMediaId(input.mediaId)) throw new VideoIntelligenceServiceError('Video media ID is invalid.', 400);
      } else resolveVideoIntelligenceJobLocator(input.locator);
      // Admission precedes hydration and lease/job mutations; status polling stays free.
      const quotaDenied = await requireOperatorQuota(access.userId,
        input.action === 'START' ? 'VIDEO_PREPARATION' : 'VIDEO_PROVIDER_WORK', 1);
      if (quotaDenied) return quotaDenied;
    }
    return NextResponse.json(await executeVideoIntelligenceStep(input, { deadlineAtMs }), { headers });
  } catch (error) { return errorResponse(error); }
}
