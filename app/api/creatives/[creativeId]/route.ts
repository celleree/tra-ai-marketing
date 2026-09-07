import { NextResponse } from 'next/server';
import { CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS, parseCreativeHumanReviewChecklist } from '@/lib/creatives/human-review';
import { isSafeCreativeId, updateCreativeReviewState } from '@/lib/creatives/storage';

export const runtime = 'nodejs';

export async function PATCH(request: Request, context: { params: Promise<{ creativeId: string }> }) {
  const invalid = (error: string) => NextResponse.json({ error }, { status: 400 });
  const { creativeId } = await context.params;
  if (!isSafeCreativeId(creativeId)) return invalid('Invalid creative ID.');
  let value: unknown;
  try { value = await request.json(); } catch { return invalid('Review request must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Review request must be an object.');
  const body = value as Record<string, unknown>;
  const allowed = body.action === 'REVIEW' ? ['action', 'checklist', 'notes'] : ['action', 'status'];
  if (Object.keys(body).some(key => !allowed.includes(key))) return invalid('Review request contains unsupported fields.');
  let update: Parameters<typeof updateCreativeReviewState>[1];
  if (body.action === 'REVIEW') {
    const checklist = parseCreativeHumanReviewChecklist(body.checklist);
    if (!checklist) return invalid('Answer every quality and compliance check with PASS or FAIL.');
    if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.trim().length > 2000)) {
      return invalid('Review notes must be text of at most 2000 characters.');
    }
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    const status = CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS.every(key => checklist[key] === 'PASS') ? 'APPROVED' : 'REJECTED';
    update = { humanReview: { status, reviewedAt: new Date().toISOString(), checklist, ...(notes ? { notes } : {}) } };
  } else if (body.action === 'SET_LIFECYCLE') {
    if (body.status !== 'ACTIVE' && body.status !== 'PAUSED') return invalid('Choose active or paused library state.');
    update = { lifecycle: { status: body.status, updatedAt: new Date().toISOString() } };
  } else return invalid('Choose review or library pause/resume.');
  try {
    const creative = await updateCreativeReviewState(creativeId, update);
    if (!creative) return NextResponse.json({ error: 'Saved creative not found.' }, { status: 404 });
    return NextResponse.json({ creative });
  } catch {
    return NextResponse.json({ error: 'Creative review state could not be saved.' }, { status: 500 });
  }
}
