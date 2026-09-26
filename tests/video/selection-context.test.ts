import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
const mocks = vi.hoisted(() => ({ read: vi.fn(), library: vi.fn(), preparation: vi.fn(), legacy: vi.fn(), preparedFrames: vi.fn(), legacyFrames: vi.fn() }));
vi.mock('@/lib/video/intelligence-job-store', () => ({ readVideoIntelligenceJob: mocks.read }));
vi.mock('@/lib/video/intelligence-finalization-runner', () => ({ loadVideoIntelligenceLibrary: mocks.library }));
vi.mock('@/lib/video/intelligence-preparation-loader', () => ({ loadVideoIntelligencePreparation: mocks.preparation }));
vi.mock('@/lib/video/library-service', async (load) => ({ ...await load<typeof import('@/lib/video/library-service')>(), loadVideoFrameLibrary: mocks.legacy }));
vi.mock('@/lib/video/prepared-selected-frames', () => ({ getApprovedPreparedSelectedTraVideoFrames: mocks.preparedFrames }));
vi.mock('@/lib/video/selected-frames', () => ({ getApprovedSelectedTraVideoFrames: mocks.legacyFrames }));
import { extractVideoSelectionFrames, loadSavedVideoSelectionContext, loadVideoSelectionContext } from '@/lib/video/selection-context';

const source = { role: 'TRA_VIDEO', media: { id: `media_${'a'.repeat(32)}` }, stored: { buffer: Buffer.from('source') } } as HydratedTraVideoSource;
const hash = createHash('sha256').update(source.stored.buffer).digest('hex');
const library = { id: 'library', representativeFrames: [] }; const manifest = { sourceVideoContentHash: hash };
const preparation = { manifestKey: 'manifest-key', manifestSha256: 'b'.repeat(64) };
const resultSha = 'c'.repeat(64);
const result = { key: `libraries/sha256/${resultSha}.json`, sha256: resultSha, byteLength: 20 };
const savedFingerprint = createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'saved-model');
const savedIdentity = { sourceVideoMediaId: source.media.id, sourceVideoContentHash: hash, analyzerFingerprint: savedFingerprint };
const savedDependency = { identity: savedIdentity, artifact: result };
const complete = () => {
  mocks.read.mockResolvedValue({ job: { phase: 'COMPLETE', preparation, result } });
  mocks.library.mockResolvedValue(library); mocks.preparation.mockResolvedValue({ manifest, representatives: [] });
};
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'current-model'); });
afterEach(() => vi.unstubAllEnvs());

it('loads exact saved B1 selection context from the frozen identity and artifact', async () => {
  complete();
  expect(await loadSavedVideoSelectionContext(source, savedDependency)).toEqual({ library, manifest, representativeImages: [] });
  expect(mocks.read).toHaveBeenCalledWith(savedIdentity);
  expect(mocks.library).toHaveBeenCalledWith(savedIdentity, result);
  expect(mocks.preparation).toHaveBeenCalledWith({ ...preparation, expectedSourceVideoMediaId: source.media.id,
    expectedSourceVideoContentHash: hash, expectedAnalyzerFingerprintSha256: savedFingerprint.sha256 });
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it('loads the saved dependency when the current analyzer configuration differs', async () => {
  complete(); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'different-current-model');
  await loadSavedVideoSelectionContext(source, savedDependency);
  expect(mocks.read.mock.calls[0][0]).toEqual(savedIdentity);
  expect(mocks.read.mock.calls[0][0].analyzerFingerprint.visionModel).toBe('saved-model');
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it('fails closed when the saved source media ID differs', async () => {
  const dependency = { ...savedDependency, identity: { ...savedIdentity, sourceVideoMediaId: `media_${'d'.repeat(32)}` } };
  await expect(loadSavedVideoSelectionContext(source, dependency)).rejects.toThrow('does not match the TRA video source');
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
});

it('fails closed when the saved source content hash differs', async () => {
  const dependency = { ...savedDependency, identity: { ...savedIdentity, sourceVideoContentHash: 'd'.repeat(64) } };
  await expect(loadSavedVideoSelectionContext(source, dependency)).rejects.toThrow('does not match the TRA video source');
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
});

it('requires the exact saved job to be complete', async () => {
  mocks.read.mockResolvedValue({ job: { phase: 'OBSERVING' } });
  await expect(loadSavedVideoSelectionContext(source, savedDependency)).rejects.toThrow('not a complete persisted job');
  expect(mocks.library).not.toHaveBeenCalled(); expect(mocks.preparation).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
});

it.each([
  ['key', { ...result, key: `libraries/sha256/${'d'.repeat(64)}.json` }],
  ['sha256', { ...result, sha256: 'd'.repeat(64) }],
  ['byteLength', { ...result, byteLength: result.byteLength + 1 }],
])('fails closed when the frozen result artifact %s is stale', async (_field, artifact) => {
  complete();
  await expect(loadSavedVideoSelectionContext(source, { identity: savedIdentity, artifact })).rejects.toThrow('does not match the frozen dependency');
  expect(mocks.library).not.toHaveBeenCalled(); expect(mocks.preparation).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
});

it('keeps explicit human identity pixels intact only when existing observation has no source mark', async () => {
  const png = Buffer.from('original-pixels');
  const context = { library: { ...library, representativeFrames: [
    { id: 'clear', observation: { visibleText: [], topics: ['person'], uncertainties: [] } },
    { id: 'marked', observation: { visibleText: ['TRA'], topics: ['brand'], uncertainties: [] } },
  ] }, manifest, representativeImages: [] } as never;
  mocks.preparedFrames.mockResolvedValue({ frames: [{ buffer: png }, { buffer: png }] });
  const selected = await extractVideoSelectionFrames(source, context, ['clear', 'marked']);
  expect(selected.frames[0].buffer).toBe(png);
  expect(selected.frames.map(frame => frame.sourceOverlay)).toEqual([
    { version: 2, status: 'CLEAN' }, { version: 2, status: 'UNSAFE' },
  ]);
});

it('fails closed when preparation validation rejects the saved analyzer binding', async () => {
  complete(); mocks.preparation.mockRejectedValue(new Error('preparation analyzer mismatch'));
  await expect(loadSavedVideoSelectionContext(source, savedDependency)).rejects.toThrow('preparation analyzer mismatch');
  expect(mocks.preparation).toHaveBeenCalledWith(expect.objectContaining({ expectedAnalyzerFingerprintSha256: savedFingerprint.sha256 }));
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it.each([
  [['frame-1']],
  [['frame-1', 'frame-2']],
  [['frame-1', 'frame-2', 'frame-3']],
])('hydrates requested known saved frame IDs through the existing extraction path', async (frameIds) => {
  complete(); const context = await loadSavedVideoSelectionContext(source, savedDependency);
  mocks.preparedFrames.mockResolvedValue({ frames: frameIds.map(id => ({ id })) });
  expect(await extractVideoSelectionFrames(source, context, frameIds)).toEqual({ frames: frameIds.map(id => ({ id,
    sourceOverlay: { version: 2, status: 'UNSAFE' } })) });
  expect(mocks.preparedFrames).toHaveBeenCalledWith(source, library, frameIds, manifest);
  expect(mocks.legacyFrames).not.toHaveBeenCalled();
});

it('prefers complete durable context bound to the hydrated source and current analyzer', async () => {
  mocks.read.mockResolvedValue({ job: { phase: 'COMPLETE', preparation, result } });
  mocks.library.mockResolvedValue(library); mocks.preparation.mockResolvedValue({ manifest, representatives: [] });
  const context = await loadVideoSelectionContext(source);
  expect(context).toEqual({ library, manifest, representativeImages: [] }); expect(mocks.legacy).not.toHaveBeenCalled();
  const identity = mocks.read.mock.calls[0][0];
  expect(identity).toMatchObject({ sourceVideoMediaId: source.media.id, sourceVideoContentHash: hash,
    analyzerFingerprint: { visionModel: 'current-model' } });
  expect(mocks.library).toHaveBeenCalledWith(identity, result);
  expect(mocks.preparation).toHaveBeenCalledWith({ ...preparation, expectedSourceVideoMediaId: source.media.id,
    expectedSourceVideoContentHash: hash, expectedAnalyzerFingerprintSha256: identity.analyzerFingerprint.sha256 });
  mocks.preparedFrames.mockResolvedValue({ frames: [{ id: 'fresh-png' }] });
  expect(await extractVideoSelectionFrames(source, context!, ['chosen'])).toEqual({ frames: [{ id: 'fresh-png',
    sourceOverlay: { version: 2, status: 'UNSAFE' } }] });
  expect(mocks.preparedFrames).toHaveBeenCalledWith(source, library, ['chosen'], manifest);
  expect(mocks.legacyFrames).not.toHaveBeenCalled();
});

it('preserves existing local evidence while refusing a filesystem fallback in production', async () => {
  mocks.read.mockResolvedValue(null); mocks.legacy.mockResolvedValue(library);
  const context = await loadVideoSelectionContext(source);
  expect(context).toEqual({ library, manifest: null, representativeImages: null }); expect(mocks.legacy).toHaveBeenCalledWith(source.media.id, hash);
  mocks.legacyFrames.mockResolvedValue({ frames: [{ id: 'chosen' }] });
  await extractVideoSelectionFrames(source, context!, ['chosen']);
  expect(mocks.legacyFrames).toHaveBeenCalledWith(source, library, ['chosen']); expect(mocks.preparedFrames).not.toHaveBeenCalled();
  mocks.legacy.mockClear(); vi.stubEnv('NODE_ENV', 'production');
  expect(await loadVideoSelectionContext(source)).toBeNull(); expect(mocks.legacy).not.toHaveBeenCalled();
});

it('does not silently fall back after durable artifact corruption or storage failure', async () => {
  mocks.read.mockResolvedValue({ job: { phase: 'COMPLETE', preparation, result } });
  mocks.library.mockRejectedValue(new Error('library corrupt')); mocks.preparation.mockResolvedValue({ manifest, representatives: [] });
  await expect(loadVideoSelectionContext(source)).rejects.toThrow('library corrupt');
  expect(mocks.legacy).not.toHaveBeenCalled();
  mocks.read.mockRejectedValue(new Error('storage unavailable'));
  await expect(loadVideoSelectionContext(source)).rejects.toThrow('storage unavailable');
  expect(mocks.legacy).not.toHaveBeenCalled();
});
