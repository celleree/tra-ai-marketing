import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FfmpegIntervalCandidateExtractor, FfmpegSceneCandidateMaterializer } from '@/lib/video/candidate-extractor';
import { FfmpegSceneChangeDetector } from '@/lib/video/scene-change-detector';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import * as ffmpeg from '@/lib/video/ffmpeg';
import * as cleanup from '@/lib/video/candidate-cleanup';
import { REAL_SCENE_CHANGE_MP4 } from '@/tests/fixtures/video-candidate-scene';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';

const mocks = vi.hoisted(() => ({ current: vi.fn(), resolve: vi.fn(), library: vi.fn(), preparation: vi.fn(),
  image: vi.fn(), actualImages: undefined as unknown as typeof import('@/lib/video/selection-context').withVideoCandidateAnalysisImages, access: vi.fn(), execute: vi.fn() }));
vi.mock('@/lib/video/intelligence-service', async original => ({ ...await original<typeof import('@/lib/video/intelligence-service')>(),
  readVideoIntelligenceSource: mocks.current, resolveExistingVideoIntelligenceJob: mocks.resolve, executeVideoIntelligenceStep: mocks.execute }));
vi.mock('@/lib/video/intelligence-finalization-runner', () => ({ loadVideoIntelligenceLibrary: mocks.library }));
vi.mock('@/lib/video/intelligence-preparation-loader', () => ({ loadVideoIntelligencePreparation: mocks.preparation }));
vi.mock('@/lib/video/selection-context', async original => {
  const actual = await original<typeof import('@/lib/video/selection-context')>();
  mocks.actualImages = actual.withVideoCandidateAnalysisImages;
  return { ...actual, withVideoCandidateAnalysisImages: mocks.image };
});
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
const hydrateSource = vi.fn<(id: string) => Promise<import('@/lib/video/candidate-extractor').HydratedTraVideoSource>>(async () => source as never);
const read = (candidateIndex?: number | readonly number[]) => discoverVideoReviewSource(locator.sourceVideoMediaId, candidateIndex, { hydrateSource });
const request = (query = '') => new Request(`http://localhost/api/video/review-sources?mediaId=${locator.sourceVideoMediaId}${query}`);
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Provider calls forbidden'); }));
  mocks.current.mockResolvedValue({ source: { id: locator.sourceVideoMediaId }, locator, status: { phase: 'COMPLETE' } });
  mocks.resolve.mockResolvedValue({ identity, job: { phase: 'COMPLETE', result: { sha256: 'e'.repeat(64) },
    preparation: { manifestKey: 'manifest', manifestSha256: 'f'.repeat(64) } } });
  mocks.library.mockResolvedValue(structuredClone(library)); mocks.preparation.mockResolvedValue({ manifest });
  mocks.image.mockImplementation(async (_source, _context, indexes, consume) => {
    const results = []; for (const index of indexes) results.push(await consume({ ...binding(index), bytes: jpg })); return results;
  }); mocks.access.mockResolvedValue(null);
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
    expect(mocks.image.mock.calls[0][2]).toEqual([1]);
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
    mocks.library.mockResolvedValue(library); mocks.image.mockImplementation(async (_source, _context, _indexes, consume) => [await consume({ candidateIndex: 1, bytes: Buffer.from('changed') })]);
    await expect(read(1)).rejects.toThrow('analysis-only TRA candidate');
  });
  it.each(['library', 'preparation'] as const)('surfaces %s integrity failure', async name => {
    mocks[name].mockRejectedValue(new Error('Artifact digest mismatch'));
    expect((await GET(request())).status).toBe(409);
  });
  it.each(['&candidateIndexes=', '&candidateIndexes=1,x', '&candidateIndexes=1,1', '&candidateIndexes=1&candidateIndex=0',
    '&candidateIndexes=' + Array.from({ length: 25 }, (_, index) => index).join(',')])('rejects invalid batches before extraction: %s', async query => {
    expect((await GET(request(query))).status).toBe(400); expect(mocks.image).not.toHaveBeenCalled();
  });
  it('rejects an unavailable member before hydrating or extracting the source', async () => {
    await expect(read([1, 99])).rejects.toMatchObject({ status: 404 });
    expect(hydrateSource).not.toHaveBeenCalled(); expect(mocks.image).not.toHaveBeenCalled();
  });
  it('requires access, validates preview input and streams large private responses in bounded chunks', async () => {
    mocks.access.mockResolvedValue(new Response('Denied', { status: 401 }));
    expect((await GET(request('&candidateIndexes=1'))).status).toBe(401); expect(mocks.current).not.toHaveBeenCalled();
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

// Mock only persisted artifacts; run discovery, validation, lifecycle, FFmpeg and thumbnail generation for real.
it('restores 20 exact neighboring previews with one preprocessing pass and releases temporary ownership', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tra-review-fixture-'));
  let buffer: Buffer;
  try {
    const file = path.join(directory, 'fixture.mp4'); await writeFile(file, REAL_SCENE_CHANGE_MP4);
    buffer = (await ffmpeg.runFfmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-stream_loop', '1', '-i', file,
      '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'])).stdout;
  } finally { await rm(directory, { recursive: true, force: true }); }
  const input = { role: 'TRA_VIDEO', media: { id: locator.sourceVideoMediaId, fileName: 'fixture.mp4',
    mimeType: 'video/mp4', mediaType: 'VIDEO', size: buffer.length, url: '/fixture.mp4' },
    stored: { buffer, fileName: 'fixture.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO' } } as import('@/lib/video/candidate-extractor').HydratedTraVideoSource;
  const policy = DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY;
  const frozen = await withTemporaryTraVideoFrameCandidates(input, async set => {
    const candidates = set.candidates.map(({ temporaryPath, lifecycle, ...candidate }) => candidate);
    const representative = candidates[0], frameId = videoCandidateFrameId(set.sourceVideoContentHash, representative.timestampMs, representative.frameSha256);
    const groups = [{ representativeIndex: 0, candidateIndexes: candidates.map(candidate => candidate.candidateIndex) }];
    return { manifest: { ...set, candidates, groups, analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(policy, 'fixture') },
      library: { ...library, sourceVideoContentHash: set.sourceVideoContentHash, candidates,
        representativeFrames: [{ ...library.representativeFrames[0], id: frameId, frameSha256: representative.frameSha256,
          timestampMs: representative.timestampMs, candidateIndexes: groups[0].candidateIndexes }] } };
  }, {}, policy);
  mocks.current.mockResolvedValue({ source: input.media, locator: { ...locator, sourceVideoContentHash: frozen.library.sourceVideoContentHash }, status: { phase: 'COMPLETE' } });
  mocks.library.mockResolvedValue(frozen.library); mocks.preparation.mockResolvedValue({ manifest: frozen.manifest });
  hydrateSource.mockResolvedValue(input); mocks.image.mockImplementation(mocks.actualImages);
  const interval = vi.spyOn(FfmpegIntervalCandidateExtractor.prototype, 'extractCandidates');
  const detect = vi.spyOn(FfmpegSceneChangeDetector.prototype, 'detect');
  const materialize = vi.spyOn(FfmpegSceneCandidateMaterializer.prototype, 'materializeCandidates');
  const commands = vi.spyOn(ffmpeg, 'runFfmpeg');
  const release = vi.spyOn(cleanup, 'cleanupTemporaryVideoFrameCandidateOwnership');
  try {
    const indexes = frozen.library.candidates.slice(1, 21).map(candidate => candidate.candidateIndex);
    expect(indexes).toHaveLength(20);
    const result = await read(indexes);
    expect(result.review!.previews).toHaveLength(20);
    for (const preview of result.review!.previews) {
      const candidate = frozen.library.candidates[preview.binding.candidateIndex];
      expect(preview.binding).toEqual({ frameId: videoCandidateFrameId(frozen.library.sourceVideoContentHash, candidate.timestampMs, candidate.frameSha256),
        representativeFrameId: frozen.library.representativeFrames[0].id, candidateIndex: candidate.candidateIndex,
        timestampMs: candidate.timestampMs, frameSha256: candidate.frameSha256 });
      expect(preview.providerEligible).toBe(false); expect(preview.thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    }
    expect(interval).toHaveBeenCalledTimes(1); expect(detect).toHaveBeenCalledTimes(1); expect(materialize).toHaveBeenCalledTimes(1);
    expect(commands).toHaveBeenCalledTimes(4); expect(release).toHaveBeenCalledTimes(1);
    for (const directory of release.mock.calls[0][0].temporaryDirectories) await expect(access(directory)).rejects.toThrow();
    interval.mockClear();
    await expect(mocks.actualImages(input, { library: frozen.library as never, manifest: frozen.manifest as never, representativeImages: null },
      Array.from({ length: 25 }, (_, index) => index), async image => image.frameId)).rejects.toThrow('batch is invalid');
    expect(interval).not.toHaveBeenCalled();
    const invalid = structuredClone(frozen.manifest); invalid.groups = [];
    mocks.preparation.mockResolvedValue({ manifest: invalid });
    await expect(read(indexes)).rejects.toMatchObject({ status: 409 }); expect(interval).not.toHaveBeenCalled();
    mocks.preparation.mockResolvedValue({ manifest: frozen.manifest });
    hydrateSource.mockResolvedValue({ ...input, stored: { buffer: Buffer.from('different source') } } as never);
    await expect(read(indexes)).rejects.toThrow('frozen TRA video preparation'); expect(interval).not.toHaveBeenCalled();
    hydrateSource.mockResolvedValue(input);
    const drift = structuredClone(frozen.library);
    drift.candidates[1].frameSha256 = 'e'.repeat(64);
    const changed = structuredClone(frozen.manifest); changed.candidates[1].frameSha256 = 'e'.repeat(64);
    mocks.library.mockResolvedValue(drift); mocks.preparation.mockResolvedValue({ manifest: changed });
    await expect(read(indexes)).rejects.toThrow('frame has drifted'); expect(interval).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    for (const directory of release.mock.calls[1][0].temporaryDirectories) await expect(access(directory)).rejects.toThrow();
  } finally { interval.mockRestore(); detect.mockRestore(); materialize.mockRestore(); commands.mockRestore(); release.mockRestore(); }
}, 30_000);
