import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { record, ReviewSelectionError } from '@/lib/video/review-selection';
import { loadVideoReviewDraft, saveVideoReviewDraft } from '@/lib/video/review-selection-store';

export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store' };
const failure = (error: unknown) => NextResponse.json({ error: error instanceof ReviewSelectionError ? error.message : 'Review draft could not be saved or loaded.' }, {
  headers, status: videoIntelligenceHttpStatus(error instanceof ReviewSelectionError ? error.status : error instanceof SyntaxError ? 400 : 500),
});
export async function GET(request: Request) {
  const denied = await requireOperatorAccess(); if (denied) return denied;
  try {
    assertDurableVideoIntelligenceAvailable();
    const query = new URL(request.url).searchParams;
    const profileHash = query.get('currentProfileSha256') ?? undefined;
    if (profileHash !== undefined && !/^[a-f0-9]{64}$/.test(profileHash)) throw new ReviewSelectionError('Current profile hash is invalid.', 400);
    return NextResponse.json(await loadVideoReviewDraft(query.get('id') ?? '', {}, profileHash), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const denied = await requireOperatorAccess(); if (denied) return denied;
  try {
    assertDurableVideoIntelligenceAvailable();
    const body: unknown = await request.json();
    if (!record(body) || Object.keys(body).length !== 3 || !['id', 'expectedRevision', 'choices'].every(key => key in body)
      || (body.id !== null && typeof body.id !== 'string') || (body.expectedRevision !== null && typeof body.expectedRevision !== 'string')) {
      throw new ReviewSelectionError('Review draft save request is invalid.', 400);
    }
    return NextResponse.json(await saveVideoReviewDraft(body as Parameters<typeof saveVideoReviewDraft>[0]), { headers });
  } catch (error) { return failure(error); }
}
