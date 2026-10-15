import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ current: vi.fn(), load: vi.fn(), mutate: vi.fn(), resolve: vi.fn(), upsert: vi.fn(), access: vi.fn() }));
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess: mocks.access }));
vi.mock('@/lib/proof/storage', async (load) => ({ ...await load<typeof import('@/lib/proof/storage')>(), mutateVideoPassageCandidate: mocks.mutate, upsertVideoPassageCandidate: mocks.upsert }));
vi.mock('@/lib/video/intelligence-service', async (load) => ({ ...await load<typeof import('@/lib/video/intelligence-service')>(), readVideoIntelligenceSource: mocks.current, resolveExistingVideoIntelligenceJob: mocks.resolve }));
vi.mock('@/lib/video/intelligence-finalization-runner', async (load) => ({ ...await load<typeof import('@/lib/video/intelligence-finalization-runner')>(), loadVideoIntelligenceLibrary: mocks.load }));
import * as route from '@/app/api/proof/video-passages/route';

const locator = { version: 1 as const, sourceVideoMediaId: `media_${'a'.repeat(32)}`, sourceVideoContentHash: 'b'.repeat(64), analyzerFingerprintSha256: 'c'.repeat(64) };
const library = { version: 1 as const, id: `video-library:${'d'.repeat(64)}`, transcript: { segments: [
  { segmentIndex: 0, startMs: 100, endMs: 200, text: 'Exact first source sentence.' },
  { segmentIndex: 1, startMs: 250, endMs: 500, text: 'Exact second source sentence.' },
] }, representativeFrames: [{ observation: { visibleText: ['Never use this model observation.'] } }] };
const request = (method: string, body: unknown) => new Request('http://localhost/api/proof/video-passages', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); mocks.access.mockResolvedValue(null);
  mocks.current.mockResolvedValue({ locator }); mocks.resolve.mockResolvedValue({ identity: { sourceVideoMediaId: locator.sourceVideoMediaId }, job: { phase: 'COMPLETE', result: { key: 'library', sha256: 'e'.repeat(64), byteLength: 1 } } }); mocks.load.mockResolvedValue(library);
  mocks.upsert.mockImplementation(async (candidate) => ({ candidate, created: true })); mocks.mutate.mockResolvedValue({ id: 'video-passage_candidate', status: 'PENDING' });
});

describe('Video Passage Candidate API', () => {
  it('derives the exact source passage, timestamps, identity, and no Proof content server-side', async () => {
    const response = await route.POST(request('POST', { locator, startSegmentIndex: 0, endSegmentIndex: 1, text: 'Client text' }));
    expect(response.status).toBe(400); expect(mocks.upsert).not.toHaveBeenCalled();
    const valid = await route.POST(request('POST', { locator, startSegmentIndex: 0, endSegmentIndex: 1 }));
    expect(valid.status).toBe(201);
    const candidate = mocks.upsert.mock.calls[0][0];
    expect(candidate).toMatchObject({ status: 'PENDING', source: { locator, library: { id: library.id, version: 1 } }, passage: { startMs: 100, endMs: 500, segments: library.transcript.segments } });
    expect(JSON.stringify(candidate)).not.toContain('Never use this model observation.');
    expect(candidate).not.toHaveProperty('approvedClaimWording'); expect(candidate).not.toHaveProperty('advertisingUseApproved');
  });

  it.each([
    ['source hash drift', () => mocks.current.mockResolvedValue({ locator: { ...locator, sourceVideoContentHash: 'f'.repeat(64) } }), { locator, startSegmentIndex: 0, endSegmentIndex: 0 }, 409],
    ['analyzer identity drift', () => mocks.current.mockResolvedValue({ locator: { ...locator, analyzerFingerprintSha256: 'e'.repeat(64) } }), { locator, startSegmentIndex: 0, endSegmentIndex: 0 }, 409],
    ['invalid range', () => undefined, { locator, startSegmentIndex: 0, endSegmentIndex: 2 }, 400],
    ['incomplete job', () => mocks.resolve.mockResolvedValue({ identity: {}, job: { phase: 'OBSERVING' } }), { locator, startSegmentIndex: 0, endSegmentIndex: 0 }, 409],
  ])('fails closed for %s', async (_name, setup, body, status) => { setup(); expect((await route.POST(request('POST', body))).status).toBe(status); expect(mocks.upsert).not.toHaveBeenCalled(); });

  it('accepts only lifecycle actions and does not accept client-owned Proof approval fields', async () => {
    expect((await route.PATCH(request('PATCH', { action: 'link', candidateId: 'candidate', proofId: 'proof' }))).status).toBe(200);
    expect(mocks.mutate).toHaveBeenCalledWith('candidate', 'link', 'proof');
    expect((await route.PATCH(request('PATCH', { action: 'dismiss', candidateId: 'candidate', advertisingUseApproved: true }))).status).toBe(400);
  });
});
