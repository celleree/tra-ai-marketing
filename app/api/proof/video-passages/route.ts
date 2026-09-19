import { isDeepStrictEqual } from 'node:util';
import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { mutateVideoPassageCandidate, upsertVideoPassageCandidate, videoPassageCandidateId, VideoPassageCandidateError } from '@/lib/proof/storage';
import type { VideoPassageCandidate } from '@/lib/proof/types';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { assertDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { readVideoIntelligenceSource, resolveExistingVideoIntelligenceJob, VideoIntelligenceServiceError, type VideoIntelligenceJobLocator } from '@/lib/video/intelligence-service';

export const runtime = 'nodejs';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'no-store' };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const locator = (value: unknown): VideoIntelligenceJobLocator | null => isRecord(value) && Object.keys(value).length === 4
  && value.version === 1 && typeof value.sourceVideoMediaId === 'string' && typeof value.sourceVideoContentHash === 'string'
  && typeof value.analyzerFingerprintSha256 === 'string' ? value as unknown as VideoIntelligenceJobLocator : null;
type CandidateRequest = { locator: VideoIntelligenceJobLocator; startSegmentIndex: number; endSegmentIndex: number };
const candidateRequest = (value: unknown): CandidateRequest | null => {
  if (!isRecord(value) || !hasOnly(value, ['locator', 'startSegmentIndex', 'endSegmentIndex'])) return null;
  const startSegmentIndex = value.startSegmentIndex, endSegmentIndex = value.endSegmentIndex;
  if (typeof startSegmentIndex !== 'number' || typeof endSegmentIndex !== 'number' || !Number.isSafeInteger(startSegmentIndex)
    || !Number.isSafeInteger(endSegmentIndex) || startSegmentIndex < 0 || endSegmentIndex < startSegmentIndex) return null;
  const requested = locator(value.locator);
  return requested ? { locator: requested, startSegmentIndex, endSegmentIndex } : null;
};
const failure = (error: unknown) => NextResponse.json({ error: error instanceof Error ? error.message : 'Video passage candidate could not be saved.' }, {
  headers, status: videoIntelligenceHttpStatus(error instanceof VideoIntelligenceServiceError || error instanceof VideoPassageCandidateError
    ? error.status : error instanceof SyntaxError ? 400 : 500),
});

export async function POST(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  try {
    assertDurableVideoIntelligenceAvailable();
    const input = candidateRequest(await request.json());
    if (!input) throw new VideoIntelligenceServiceError('Video passage candidate request is invalid.', 400);
    const deadlineAtMs = Date.now() + maxDuration * 1_000 - 5_000;
    const current = await readVideoIntelligenceSource(input.locator.sourceVideoMediaId, { deadlineAtMs });
    if (!isDeepStrictEqual(current.locator, input.locator)) throw new VideoIntelligenceServiceError('Video source or analyzer identity changed. Reanalyze it before creating a passage candidate.', 409);
    const { identity, job } = await resolveExistingVideoIntelligenceJob(current.locator, {});
    if (job.phase !== 'COMPLETE' || !job.result) throw new VideoIntelligenceServiceError('Video analysis is not complete.', 409);
    const library = await loadVideoIntelligenceLibrary(identity, job.result);
    const segments = library.transcript.segments.slice(input.startSegmentIndex, input.endSegmentIndex + 1);
    if (segments.length !== input.endSegmentIndex - input.startSegmentIndex + 1) throw new VideoIntelligenceServiceError('Transcript segment range is unavailable.', 400);
    const passage = { startSegmentIndex: input.startSegmentIndex, endSegmentIndex: input.endSegmentIndex,
      startMs: segments[0].startMs, endMs: segments.at(-1)!.endMs,
      segments: segments.map(({ segmentIndex, startMs, endMs, text }) => ({ segmentIndex, startMs, endMs, text })) };
    const source: VideoPassageCandidate['source'] = { locator: current.locator, library: { id: library.id, version: library.version } };
    const timestamp = new Date().toISOString();
    const candidate: VideoPassageCandidate = { version: 1, id: videoPassageCandidateId(source, passage), status: 'PENDING', source, passage, createdAt: timestamp, updatedAt: timestamp };
    const saved = await upsertVideoPassageCandidate(candidate);
    return NextResponse.json(saved, { headers, status: saved.created ? 201 : 200 });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  try {
    const body: unknown = await request.json();
    if (!isRecord(body) || !hasOnly(body, ['action', 'candidateId', 'proofId']) || typeof body.candidateId !== 'string'
      || !['link', 'dismiss', 'reopen'].includes(String(body.action))
      || (body.action === 'link' && typeof body.proofId !== 'string') || (body.action !== 'link' && body.proofId !== undefined)) {
      throw new VideoPassageCandidateError('Video passage candidate update is invalid.', 400);
    }
    return NextResponse.json({ candidate: await mutateVideoPassageCandidate(body.candidateId, body.action as 'link' | 'dismiss' | 'reopen', body.proofId as string | undefined) }, { headers });
  } catch (error) { return failure(error); }
}
