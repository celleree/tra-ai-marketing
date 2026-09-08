import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
const mocks = vi.hoisted(() => ({ read: vi.fn(), library: vi.fn(), preparation: vi.fn(), legacy: vi.fn(), preparedFrames: vi.fn(), legacyFrames: vi.fn() }));
vi.mock('@/lib/video/intelligence-job-store', () => ({ readVideoIntelligenceJob: mocks.read }));
vi.mock('@/lib/video/intelligence-finalization-runner', () => ({ loadVideoIntelligenceLibrary: mocks.library }));
vi.mock('@/lib/video/intelligence-preparation-loader', () => ({ loadVideoIntelligencePreparation: mocks.preparation }));
vi.mock('@/lib/video/library-service', async (load) => ({ ...await load<typeof import('@/lib/video/library-service')>(), loadVideoFrameLibrary: mocks.legacy }));
vi.mock('@/lib/video/prepared-selected-frames', () => ({ getApprovedPreparedSelectedTraVideoFrames: mocks.preparedFrames }));
vi.mock('@/lib/video/selected-frames', () => ({ getApprovedSelectedTraVideoFrames: mocks.legacyFrames }));
import { extractVideoSelectionFrames, loadVideoSelectionContext } from '@/lib/video/selection-context';

const source = { role: 'TRA_VIDEO', media: { id: `media_${'a'.repeat(32)}` }, stored: { buffer: Buffer.from('source') } } as HydratedTraVideoSource;
const hash = createHash('sha256').update(source.stored.buffer).digest('hex');
const library = { id: 'library' }; const manifest = { sourceVideoContentHash: hash };
const preparation = { manifestKey: 'manifest-key', manifestSha256: 'b'.repeat(64) };
const result = { key: 'library-key', sha256: 'c'.repeat(64), byteLength: 20 };
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'current-model'); });
afterEach(() => vi.unstubAllEnvs());

it('prefers complete durable context bound to the hydrated source and current analyzer', async () => {
  mocks.read.mockResolvedValue({ job: { phase: 'COMPLETE', preparation, result } });
  mocks.library.mockResolvedValue(library); mocks.preparation.mockResolvedValue({ manifest });
  const context = await loadVideoSelectionContext(source);
  expect(context).toEqual({ library, manifest }); expect(mocks.legacy).not.toHaveBeenCalled();
  const identity = mocks.read.mock.calls[0][0];
  expect(identity).toMatchObject({ sourceVideoMediaId: source.media.id, sourceVideoContentHash: hash,
    analyzerFingerprint: { visionModel: 'current-model' } });
  expect(mocks.library).toHaveBeenCalledWith(identity, result);
  expect(mocks.preparation).toHaveBeenCalledWith({ ...preparation, expectedSourceVideoMediaId: source.media.id,
    expectedSourceVideoContentHash: hash, expectedAnalyzerFingerprintSha256: identity.analyzerFingerprint.sha256 });
  mocks.preparedFrames.mockResolvedValue({ frames: ['fresh-png'] });
  expect(await extractVideoSelectionFrames(source, context!, ['chosen'])).toEqual({ frames: ['fresh-png'] });
  expect(mocks.preparedFrames).toHaveBeenCalledWith(source, library, ['chosen'], manifest);
  expect(mocks.legacyFrames).not.toHaveBeenCalled();
});

it('preserves existing local evidence while refusing a filesystem fallback in production', async () => {
  mocks.read.mockResolvedValue(null); mocks.legacy.mockResolvedValue(library);
  const context = await loadVideoSelectionContext(source);
  expect(context).toEqual({ library, manifest: null }); expect(mocks.legacy).toHaveBeenCalledWith(source.media.id, hash);
  await extractVideoSelectionFrames(source, context!, ['chosen']);
  expect(mocks.legacyFrames).toHaveBeenCalledWith(source, library, ['chosen']); expect(mocks.preparedFrames).not.toHaveBeenCalled();
  mocks.legacy.mockClear(); vi.stubEnv('NODE_ENV', 'production');
  expect(await loadVideoSelectionContext(source)).toBeNull(); expect(mocks.legacy).not.toHaveBeenCalled();
});

it('does not silently fall back after durable artifact corruption or storage failure', async () => {
  mocks.read.mockResolvedValue({ job: { phase: 'COMPLETE', preparation, result } });
  mocks.library.mockRejectedValue(new Error('library corrupt')); mocks.preparation.mockResolvedValue({ manifest });
  await expect(loadVideoSelectionContext(source)).rejects.toThrow('library corrupt');
  expect(mocks.legacy).not.toHaveBeenCalled();
  mocks.read.mockRejectedValue(new Error('storage unavailable'));
  await expect(loadVideoSelectionContext(source)).rejects.toThrow('storage unavailable');
  expect(mocks.legacy).not.toHaveBeenCalled();
});
