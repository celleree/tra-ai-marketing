import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { isSafeMediaId } from '@/lib/media/storage';
import { CreativeSourceHydrationError } from '@/lib/media/source-hydration';
import { isApprovedHumanId } from '@/lib/video/approved-human';
import { listApprovedHumanFrames } from '@/lib/video/approved-human-store';
import { approveHumanFrame, changeApprovedHumanActive, readApprovedHumanPreview } from '@/lib/video/approved-human-service';
import { parseGenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';

export const runtime = 'nodejs';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'private, no-store' };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const bodyWithKeys = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value
  && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => key in value);

async function withOperator(action: (userId: string) => Promise<Response>) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    assertDurableVideoIntelligenceAvailable();
    return await action(access.userId);
  } catch (error) {
    const status = error instanceof CreativeSourceHydrationError ? error.status : error instanceof SyntaxError ? 400 : 409;
    return json({ error: error instanceof Error ? error.message : 'The approved-human operation failed.' }, videoIntelligenceHttpStatus(status));
  }
}

export const GET = (request: Request) => withOperator(async () => {
  const id = new URL(request.url).searchParams.get('preview');
  if (id !== null) {
    if (!isApprovedHumanId(id)) return json({ error: 'Choose a valid approved human.' }, 400);
    return new Response(new Uint8Array(await readApprovedHumanPreview(id)), { headers: { ...headers, 'Content-Type': 'image/png' } });
  }
  return json({ records: await listApprovedHumanFrames() });
});

export const POST = (request: Request) => withOperator(async userId => {
  const body: unknown = await request.json();
  if (!bodyWithKeys(body, ['mediaId', 'videoFrameSelection', 'previewPngSha256', 'description'])) return json({ error: 'Invalid approval request.' }, 400);
  const selection = parseGenerateVideoFrameSelection(body.videoFrameSelection);
  if (typeof body.mediaId !== 'string' || !isSafeMediaId(body.mediaId) || !selection || selection.frameIds.length !== 1
    || typeof body.previewPngSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewPngSha256)
    || typeof body.description !== 'string' || !body.description.trim() || body.description.length > 500) {
    return json({ error: 'Preview one TRA frame and provide brief approval notes.' }, 400);
  }
  const denied = await requireOperatorQuota(userId, 'VIDEO_FRAME_PREVIEW', 1);
  if (denied) return denied;
  return json({ record: await approveHumanFrame({ mediaId: body.mediaId, selection,
    previewPngSha256: body.previewPngSha256, description: body.description.trim() }, userId) });
});

export const PATCH = (request: Request) => withOperator(async userId => {
  const body: unknown = await request.json();
  if (!bodyWithKeys(body, ['id', 'active']) || !isApprovedHumanId(body.id) || typeof body.active !== 'boolean') {
    return json({ error: 'Choose an approved human and activation state.' }, 400);
  }
  if (body.active) {
    const denied = await requireOperatorQuota(userId, 'VIDEO_FRAME_PREVIEW', 1);
    if (denied) return denied;
  }
  return json({ record: await changeApprovedHumanActive(body.id, body.active) });
});
