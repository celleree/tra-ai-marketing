import { DiscoveryError } from '@/lib/discovery/errors';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { getMediaStorage } from '@/lib/media/local-storage';
import { getMaxUploadBytes, prepareMediaImage } from '@/lib/media/storage';
import { addToReferenceLibrary } from '@/lib/references/storage';
import { extractCandidates, parseSearch, rankCandidates, sampleRows } from '@/lib/discovery/model';
import { assertProviderAvailable, providerAvailable, readDataset, readRun, startSearch } from '@/lib/discovery/provider';
import { loadSession, saveSession, updateSession, type DiscoverySession } from '@/lib/discovery/storage';
import { downloadSelectedImage } from '@/lib/discovery/media';
import { analyzeVisualPattern, assertVisualAnalysisAvailable, visualAnalysisAvailable } from '@/lib/discovery/analysis';
import { storeSelectedImage } from '@/lib/discovery/import';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { fingerprintImage } from '@/lib/discovery/fingerprint';
export const runtime = 'nodejs';
export const maxDuration = 300;
const response = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
const summary = (session: DiscoverySession) => ({ session, performance: 'Unavailable: TRA account performance has not been imported or authoritatively linked.', analysis: 'Copy heuristics are unverified. Optional visual analysis is model inference, never identity approval or performance evidence.' });
export async function GET(request: Request) {
  const access = await getOperatorAccess(); if (!access.allowed) return operatorAccessDeniedResponse(access);
  const id = new URL(request.url).searchParams.get('session');
  if (!id) return response({ providerAvailable: providerAvailable(), visualAnalysisAvailable: visualAnalysisAvailable(), providerMessage: 'Live search requires separately approved provider access and paid execution. Samples make no remote calls.' });
  try { return response(summary((await loadSession(access.userId, id)).session)); }
  catch { return response({ error: 'Discovery session could not be loaded.' }, 404); }
}
export async function POST(request: Request) {
  const access = await getOperatorAccess(); if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    if (Number(request.headers.get('content-length')) > getMaxUploadBytes() + 65536) return response({ error: 'Request is too large.' }, 413);
    const multipart = request.headers.get('content-type')?.includes('multipart/form-data');
    const form = multipart ? await request.formData() : null;
    const body = form ? Object.fromEntries(form.entries()) : await request.json() as Record<string, unknown>;
    const action = body.action;
    if (action === 'search' || action === 'sample') {
      const search = parseSearch(body), sample = action === 'sample';
      const session: DiscoverySession = { version: 1, id: randomUUID().replaceAll('-', ''), createdAt: new Date().toISOString(), search, sample, candidates: [], exactDuplicates: 0, imports: {}, feedback: {} };
      // Persist reservation first. Never retry an ambiguous paid submission automatically.
      if (!sample) assertProviderAvailable();
      if (!sample) session.submission = 'reserved';
      await saveSession(access.userId, session, null);
      const snapshot = await loadSession(access.userId, session.id);
      if (sample) Object.assign(session, rankCandidates(extractCandidates(sampleRows, session.id, 'sample', session.createdAt), search));
      else {
        try { session.run = await startSearch(search); session.submission = 'submitted'; }
        catch {
          session.submission = 'unknown';
          await saveSession(access.userId, session, snapshot.etag).catch(() => {});
          return response({ error: 'Submission outcome is unknown. Do not retry until the provider console is checked.', sessionId: session.id }, 502);
        }
      }
      try { await saveSession(access.userId, session, snapshot.etag); }
      catch { return response({ error: 'Run may have started but its receipt could not be saved. Check the provider console before retrying.', runId: session.run?.id, sessionId: session.id }, 502); }
      return response(summary(session));
    }
    const { session, etag } = await loadSession(access.userId, String(body.sessionId ?? ''));
    if (action === 'refresh') {
      if (!session.run) return response(summary(session));
      session.run = await readRun(session.run.id);
      if (session.run.status === 'SUCCEEDED' && session.run.defaultDatasetId) Object.assign(session, rankCandidates(extractCandidates(await readDataset(session.run.defaultDatasetId, session.search.limit), session.run.id, 'apify/facebook-ads-scraper', new Date().toISOString()), session.search));
      await saveSession(access.userId, session, etag); return response(summary(session));
    }
    const candidate = session.candidates.find(item => item.id === body.candidateId);
    if (!candidate) return response({ error: 'Select a result from this discovery session.' }, 400);
    if (action === 'analyze') {
      if (session.sample) return response({ error: 'Fictional samples cannot be sent for visual analysis.' }, 400);
      if (body.approveTransfer !== true) return response({ error: 'Explicitly approve paid visual analysis and image transfer for this result.' }, 400);
      assertVisualAnalysisAvailable();
      const cached = session.visualEvidence?.[candidate.id];
      if (cached && cached.imageSha256 === session.fingerprints?.[candidate.id]?.byteSha256) return response(summary(session));
      if (cached) { delete session.visualEvidence?.[candidate.id]; delete session.analysisAttempts?.[candidate.id]; delete session.analysisTokens?.[candidate.id]; }
      if (session.analysisAttempts?.[candidate.id]) return response({ error: 'An analysis attempt already exists. Check its outcome before any further paid request.' }, 409);
      const quotaDenied = await requireOperatorQuota(access.userId, 'REFERENCE_CLASSIFICATION', 1); if (quotaDenied) return quotaDenied;
      const uploadedMedia = session.imports[candidate.id];
      const source = uploadedMedia ? await getMediaStorage().readImage(uploadedMedia.fileName) : await (async () => {
        assertProviderAvailable(); const file = await downloadSelectedImage(candidate.imageUrl); const { buffer, fileName, mimeType } = await prepareMediaImage(file); return { buffer, fileName, mimeType };
      })();
      if (!source) return response({ error: 'Selected image is no longer available.' }, 400);
      const fingerprint = await fingerprintImage(source.buffer), attempt = randomUUID();
      session.fingerprints = { ...session.fingerprints, [candidate.id]: fingerprint };
      session.analysisTokens = { ...session.analysisTokens, [candidate.id]: attempt };
      session.analysisAttempts = { ...session.analysisAttempts, [candidate.id]: 'reserved' };
      await saveSession(access.userId, session, etag);
      try {
        const evidence = await analyzeVisualPattern(source);
        if (evidence.imageSha256 !== fingerprint.byteSha256) throw new DiscoveryError('Analysis did not match its source image.');
        const saved = await updateSession(access.userId, session.id, current => {
          if (current.analysisTokens?.[candidate.id] !== attempt || current.fingerprints?.[candidate.id]?.byteSha256 !== fingerprint.byteSha256) return;
          current.visualEvidence = { ...current.visualEvidence, [candidate.id]: evidence };
          current.analysisAttempts = { ...current.analysisAttempts, [candidate.id]: 'succeeded' };
        }); Object.assign(session, saved);
      } catch {
        await updateSession(access.userId, session.id, current => {
          if (current.analysisTokens?.[candidate.id] === attempt && current.fingerprints?.[candidate.id]?.byteSha256 === fingerprint.byteSha256 && !current.visualEvidence?.[candidate.id]) current.analysisAttempts = { ...current.analysisAttempts, [candidate.id]: 'unknown' };
        }).catch(() => {});
        return response({ error: 'Analysis outcome is unknown or its receipt could not be saved. No automatic retry is allowed; review the provider console.', sessionId: session.id }, 502);
      }
      return response(summary(session));
    }
    if (action === 'feedback') {
      if (body.optIn !== true || !['approved', 'rejected'].includes(String(body.decision))) return response({ error: 'Opt in and choose approve or reject. Performance attribution is unavailable.' }, 400);
      session.feedback[candidate.id] = body.decision as 'approved' | 'rejected';
      await saveSession(access.userId, session, etag); return response(summary(session));
    }
    if (action === 'import') {
      if (session.sample) return response({ error: 'Fictional samples cannot be imported.' }, 400);
      if (body.confirmRights !== true && body.confirmRights !== 'true') return response({ error: 'Confirm you may store and use this image as a layout reference.' }, 400);
      // Only a server-stored candidate URL may be fetched; callers cannot submit URLs.
      const uploaded = form?.get('image');
      let media: DiscoverySession['imports'][string] | undefined = session.imports[candidate.id];
      if (media && ((uploaded instanceof File && uploaded.size) || !await getMediaStorage().readImage(media.fileName))) media = undefined;
      if (!media) {
        const file = uploaded instanceof File && uploaded.size ? uploaded : await (async () => { assertProviderAvailable(); return downloadSelectedImage(candidate.imageUrl); })();
        if (file.size > getMaxUploadBytes()) return response({ error: 'Image is too large.' }, 413);
        const stored = await storeSelectedImage(access.userId, file); media = stored.media;
        const priorHash = session.fingerprints?.[candidate.id]?.byteSha256 ?? session.acquisitions?.[candidate.id]?.imageSha256;
        if (priorHash !== stored.imageSha256 || (session.visualEvidence?.[candidate.id] && session.visualEvidence[candidate.id].imageSha256 !== stored.imageSha256)) {
          delete session.visualEvidence?.[candidate.id]; delete session.analysisAttempts?.[candidate.id]; delete session.analysisTokens?.[candidate.id];
        }
        session.fingerprints = { ...session.fingerprints, [candidate.id]: stored.fingerprint };
        session.similarImports = { ...session.similarImports, [candidate.id]: stored.similarImages };
        session.imports[candidate.id] = media;
        session.acquisitions = { ...session.acquisitions, [candidate.id]: { method: uploaded instanceof File && uploaded.size ? 'operator-upload' : 'provider-download', savedAt: new Date().toISOString(), imageSha256: stored.imageSha256, reused: stored.reused } };
        // Durable provenance before library registration. Retry reuses the same media ID.
        await saveSession(access.userId, session, etag);
      }
      await addToReferenceLibrary([{ media, referenceType: 'layout', angle: 'customer-problems', angleSource: 'fallback' }]);
      return response({ ...summary(session), imported: media.id, notice: 'Imported as a layout reference. No identity, claims, or performance approval is implied. Manual uploads are operator-linked, not independently matched.' });
    }
    return response({ error: 'Unknown discovery action.' }, 400);
  } catch (error) {
    const message = error instanceof DiscoveryError ? error.message : 'Discovery could not complete this operation. Refresh the saved session before retrying. If a paid submission was interrupted, check the provider console first.';
    // Never expose provider response bodies or credentials.
    return response({ error: message }, message.includes('disabled') ? 503 : 400);
  }
}
