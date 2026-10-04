import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';

const mocks = vi.hoisted(() => ({ current: vi.fn(), resolve: vi.fn(), library: vi.fn(), preparation: vi.fn(),
  image: vi.fn(), access: vi.fn(), execute: vi.fn() }));
vi.mock('@/lib/video/intelligence-service', async original => ({ ...await original<typeof import('@/lib/video/intelligence-service')>(),
  readVideoIntelligenceSource: mocks.current, resolveExistingVideoIntelligenceJob: mocks.resolve, executeVideoIntelligenceStep: mocks.execute }));
vi.mock('@/lib/video/intelligence-finalization-runner', () => ({ loadVideoIntelligenceLibrary: mocks.library }));
vi.mock('@/lib/video/intelligence-preparation-loader', () => ({ loadVideoIntelligencePreparation: mocks.preparation }));
vi.mock('@/lib/video/selection-context', () => ({ loadVideoCandidateAnalysisImage: mocks.image }));
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess: mocks.access }));
import { discoverVideoReviewSource } from '@/lib/video/review-source-discovery';
import { GET } from '@/app/api/video/review-sources/route';

const jpg = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#816344' } }).jpeg().toBuffer();
const hash = createHash('sha256').update(jpg).digest('hex');
const locator = { version: 1 as const, sourceVideoMediaId: `media_${'a'.repeat(32)}`, sourceVideoContentHash: 'b'.repeat(64),
  analyzerFingerprintSha256: 'c'.repeat(64) };
const candidates = [0, 1].map(candidateIndex => ({ candidateIndex, timestampMs: candidateIndex * 1000, frameSha256: hash,
  sourceVideoMediaId: locator.sourceVideoMediaId, sourceVideoContentHash: locator.sourceVideoContentHash,
  width: 96, height: 96, byteLength: jpg.length, providerEligible: false, sourceRole: 'TRA_VIDEO', mimeType: 'image/jpeg' }));
const binding = (index: number) => ({ frameId: videoCandidateFrameId(locator.sourceVideoContentHash, index * 1000, hash),
  representativeFrameId: videoCandidateFrameId(locator.sourceVideoContentHash, 0, hash), candidateIndex: index, timestampMs: index * 1000, frameSha256: hash });
const segments = [{ segmentIndex: 0, startMs: 0, endMs: 1000, text: 'Exact source wording.' },
  { segmentIndex: 1, startMs: 1000, endMs: 2000, text: 'Results vary.' }];
const library = { id: `video-library:${'d'.repeat(64)}`, sourceVideoMediaId: locator.sourceVideoMediaId,
  sourceVideoContentHash: locator.sourceVideoContentHash, providerEligible: false, candidates,
  transcript: { version: 1, language: 'en', model: 'whisper-1', segments }, representativeFrames: [{ id: binding(0).frameId,
    candidateIndex: 0, candidateIndexes: [0, 1], thumbnailDataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}`,
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', observation: { visibleText: ['Free consultation', ''], uncertainties: ['Small print unclear.'] } }] };
const manifest = { candidates, groups: [{ representativeIndex: 0, candidateIndexes: [0, 1] }] };
const identity = { sourceVideoMediaId: locator.sourceVideoMediaId, sourceVideoContentHash: locator.sourceVideoContentHash,
  analyzerFingerprint: { sha256: locator.analyzerFingerprintSha256 } };
const source = { media: { id: locator.sourceVideoMediaId }, stored: { buffer: Buffer.from('original') } };
const hydrateSource = vi.fn(async () => source as never);
const read = (candidateIndex?: number) => discoverVideoReviewSource(locator.sourceVideoMediaId, candidateIndex, { hydrateSource });
const request = (query = '') => new Request(`http://localhost/api/video/review-sources?mediaId=${locator.sourceVideoMediaId}${query}`);
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Provider calls forbidden'); }));
  mocks.current.mockResolvedValue({ source: { id: locator.sourceVideoMediaId }, locator, status: { phase: 'COMPLETE' } });
  mocks.resolve.mockResolvedValue({ identity, job: { phase: 'COMPLETE', result: { sha256: 'e'.repeat(64) },
    preparation: { manifestKey: 'manifest', manifestSha256: 'f'.repeat(64) } } });
  mocks.library.mockResolvedValue(structuredClone(library)); mocks.preparation.mockResolvedValue({ manifest });
  mocks.image.mockResolvedValue({ ...binding(1), bytes: jpg }); mocks.access.mockResolvedValue(null);
  hydrateSource.mockResolvedValue(source as never);
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('completed video review source discovery', () => {
  it('exposes exact frozen identities, representative thumbnails, groups, neighbors and transcript context', async () => {
    const result = await read();
    expect(result.review).toMatchObject({ video: { locator, libraryId: library.id, librarySha256: 'e'.repeat(64), preparationSha256: 'f'.repeat(64) },
      library, technicalGroups: manifest.groups, frameBindings: [binding(0), binding(1)], preview: null });
    expect(mocks.preparation).toHaveBeenCalledWith({ manifestKey: 'manifest', manifestSha256: 'f'.repeat(64),
      expectedSourceVideoMediaId: locator.sourceVideoMediaId, expectedSourceVideoContentHash: locator.sourceVideoContentHash,
      expectedAnalyzerFingerprintSha256: locator.analyzerFingerprintSha256 }, { hydrateSource });
    expect(mocks.image).not.toHaveBeenCalled();
  });
  it('binds visible statements only to the observed representative, never neighboring candidates', async () => {
    const statements = (await read()).review!.onScreenStatements;
    expect(statements).toEqual([{ reference: { type: 'VIDEO_ON_SCREEN', frame: binding(0), statementIndex: 0 }, wording: 'Free consultation',
      context: { type: 'VIDEO_ON_SCREEN', evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', observation: library.representativeFrames[0].observation } }]);
  });
  it('reuses a representative thumbnail and locally previews one neighbor without granting eligibility', async () => {
    expect((await read(0)).review!.preview).toEqual({ binding: binding(0), providerEligible: false,
      thumbnailDataUrl: library.representativeFrames[0].thumbnailDataUrl });
    expect(mocks.image).not.toHaveBeenCalled();
    const preview = (await read(1)).review!.preview!;
    expect(preview).toMatchObject({ binding: binding(1), providerEligible: false });
    expect(preview.thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(hydrateSource).toHaveBeenCalledWith(locator.sourceVideoMediaId); expect(mocks.image).toHaveBeenCalledTimes(1);
    expect(mocks.image.mock.calls[0][2]).toBe(1);
  });
  it.each([null, { phase: 'OBSERVING' }, { phase: 'RETRY_REQUIRED' }])('reads incomplete work without starting or resuming it', async status => {
    mocks.current.mockResolvedValue({ source: {}, locator, status });
    expect((await read()).review).toBeNull(); expect(mocks.resolve).not.toHaveBeenCalled();
    await expect(read(1)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects missing candidates, mismatched groups and drifted JPEGs', async () => {
    await expect(read(9)).rejects.toMatchObject({ status: 404 });
    mocks.library.mockResolvedValue({ ...library, candidates: [{ ...candidates[0], timestampMs: 99 }] });
    await expect(read()).rejects.toMatchObject({ status: 409 });
    mocks.library.mockResolvedValue(library); mocks.image.mockResolvedValue({ bytes: Buffer.from('changed') });
    await expect(read(1)).rejects.toThrow('analysis-only TRA candidate');
  });
  it.each(['library', 'preparation'] as const)('surfaces %s integrity failure', async name => {
    mocks[name].mockRejectedValue(new Error('Artifact digest mismatch'));
    expect((await GET(request())).status).toBe(409);
  });
  it('requires access, validates preview input and streams large private responses in bounded chunks', async () => {
    mocks.access.mockResolvedValue(new Response('Denied', { status: 401 }));
    expect((await GET(request())).status).toBe(401); expect(mocks.current).not.toHaveBeenCalled();
    mocks.access.mockResolvedValue(null);
    expect((await GET(request('&candidateIndex=-1'))).status).toBe(400);
    mocks.library.mockResolvedValue({ ...library, padding: 'x'.repeat(5 * 1024 * 1024) });
    const response = await GET(request()); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = [];
    while (true) { const next = await reader.read(); if (next.done) break;
      expect(next.value.length).toBeLessThanOrEqual(64 * 1024); chunks.push(next.value); }
    expect(JSON.parse(Buffer.concat(chunks).toString()).review.video.locator).toEqual(locator);
  });
});
