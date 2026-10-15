import { createHash } from 'node:crypto';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { compositeCreativeBrandLogo, resolveCreativeBrandLogoGeometry } from '@/lib/creatives/brand-logo.server';
import { isCreativeLogoAnchor } from '@/lib/creatives/logo-placement';
import { validateGeneratedCreativeImage } from '@/lib/creatives/generated-image-validation';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { isSafeCreativeId, listCreatives, saveCreativeBatch } from '@/lib/creatives/storage';
import { getMediaStorage } from '@/lib/media/local-storage';
import { isSafeMediaId } from '@/lib/media/storage';
import { CheckpointUnavailableError, runDurableCheckpoint, submissionRunId } from '@/lib/creatives/durable-checkpoint';
import { parseSubmissionId, SUBMISSION_HEADER, SubmissionConflictError } from '@/lib/creatives/submission-id';
import type { CreativeRecord } from '@/lib/creatives/generated';

export const runtime = 'nodejs';
export const maxDuration = 300;
const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
class LogoSaveError extends Error {}

/** Deterministic original-artwork overlay only; no planner, image provider or AI quota. */
export async function POST(request: Request, context: { params: Promise<{ creativeId: string }> }) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  const { creativeId: parentId } = await context.params;
  if (!isSafeCreativeId(parentId)) return json({ error: 'Invalid creative ID.' }, 400);
  const key = parseSubmissionId(request.headers.get(SUBMISSION_HEADER));
  if (!key) return json({ error: 'A valid Idempotency-Key is required for this logo save.' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Supply the saved original logo and its position.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'anchor,logoMediaId'
    || !isSafeMediaId(body.logoMediaId) || !isCreativeLogoAnchor(body.anchor)) return json({ error: 'Supply the saved original logo and its position.' }, 400);
  const { logoMediaId, anchor } = body;
  const runId = submissionRunId(access.userId, key, `logo:${parentId}`), id = 'creative_' + hash(runId).slice(0, 32);
  const intent = { parentId, logoMediaId, anchor };
  try {
    const result = await runDurableCheckpoint(runId, 'logo-version', intent, async assertCurrent => {
      const records = await listCreatives(), existing = records.find(record => record.id === id);
      if (existing) {
        if (existing.identity?.parentCreativeId !== parentId || existing.generationProvenance?.logoOverlaySource?.mediaId !== logoMediaId
          || existing.generationProvenance?.revision?.logoOverlay?.anchor !== anchor) throw new SubmissionConflictError('Saved logo version does not match this intent.');
        return { creative: existing };
      }
      const parent = records.find(record => record.id === parentId);
      if (!parent) throw new LogoSaveError('Saved creative not found.');
      if (!parent.identity || !parent.planning || !parent.generationProvenance || !parent.placement || !parent.format) throw new LogoSaveError('This saved creative does not have the source history needed for a logo-only version.');
      if (parent.generationProvenance.logoOverlaySource) throw new LogoSaveError('This creative already has its original logo overlay. Preserve it.');
      const storage = getMediaStorage();
      const [canvas, logo] = await Promise.all([storage.readImageById(parent.image.id), storage.readImageById(logoMediaId)]);
      if (!canvas || !logo) throw new LogoSaveError('The saved image or original logo is unavailable. Restore the original asset in Company > Brand Guidelines.');
      await validateGeneratedCreativeImage(canvas.buffer, parent.placement);
      const geometry = await resolveCreativeBrandLogoGeometry(logo.buffer, parent.placement, anchor);
      const output = await compositeCreativeBrandLogo(canvas.buffer, logo.buffer, geometry);
      await validateGeneratedCreativeImage(output, parent.placement);
      await assertCurrent();
      const image = await runDurableCheckpoint(runId, 'logo-media', { ...intent, canvasSha256: hash(canvas.buffer), logoSha256: hash(logo.buffer), outputSha256: hash(output) },
        () => storage.saveImage(new File([new Uint8Array(output)], `tra-logo-version-${id}.png`, { type: 'image/png' })), { safeToResume: true });
      const { humanReview: _review, lifecycle: _lifecycle, ...source } = parent;
      const record: CreativeRecord = { ...source, id, createdAt: new Date().toISOString(), image,
        identity: buildCreativeIdentity({ creativeId: id, operation: 'EDIT', parent }),
        planning: { ...parent.planning, logoAnchor: anchor },
        generationProvenance: { ...parent.generationProvenance, logoOverlaySource: { mediaId: logoMediaId, sha256: hash(logo.buffer) },
          revision: { parentCreativeId: parentId, canvasMediaId: parent.image.id, canvasSha256: hash(canvas.buffer),
            instruction: 'Add the saved original company logo without AI; preserve the accepted image and copy.',
            logoOverlay: { version: 1, anchor, outputSha256: hash(output) } } } };
      await assertCurrent();
      const [saved] = await saveCreativeBatch([record]);
      return { creative: saved };
    }, { safeToResume: true });
    return json(result, 201);
  } catch (error) {
    if (error instanceof CheckpointUnavailableError) return json({ error: error.status === 202 ? 'This logo save is still running. Reload before repeating the same save.' : 'Saved logo work is unavailable. Reload the library before continuing.' }, error.status);
    if (error instanceof SubmissionConflictError || error instanceof LogoSaveError) return json({ error: error.message }, 409);
    return json({ error: 'The logo-only version could not be saved. The original is unchanged; reload the library before trying the same save again.' }, 409);
  }
}
