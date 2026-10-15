import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { newCreativePortfolio, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { videoIntelligenceJobId } from '@/lib/video/intelligence-job';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { readCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
const fixture = vi.hoisted(() => ({ approval: {} as Record<string, unknown>, inventory: vi.fn() }));
vi.mock('@/lib/creatives/preview-test-binding', () => ({ PREVIEW_TEST_APPROVAL: fixture.approval }));
vi.mock('@/lib/creatives/generation-sources', async original => ({
  ...await original<typeof import('@/lib/creatives/generation-sources')>(), hydratePlanningSourceInventory: fixture.inventory,
}));
import { initializeApprovedPreviewPortfolio } from '@/lib/creatives/preview-test-initialization';
import { previewTestRequestHash } from '@/lib/creatives/preview-test-approval';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const oldId = 'portfolio_' + 'a'.repeat(32), newId = 'portfolio_' + 'b'.repeat(32);
const key = (id: string) => `creative-portfolios/v1/${id}.json`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
let storage: MemoryPortfolioStorage, previous: CreativePortfolioJob;
beforeEach(async () => {
  vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'gpt-6-luna');
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Unexpected provider dispatch'); }));
  const video = { role: 'TRA_VIDEO' as const, mediaId: 'media_' + 'c'.repeat(32), sha256: sha('video') };
  const layout = { role: 'LAYOUT_REFERENCE' as const, mediaId: 'media_' + 'd'.repeat(32), sha256: sha('layout') };
  const request = { context: 'Frozen selected context', variationCount: 2, placement: 'PORTRAIT_4_5' as const,
    sourceAssets: [video, layout].map(({ sha256: _hash, ...source }) => source), previewOmitBrandLogo: true as const };
  previous = newCreativePortfolio(request, 1000); previous.id = oldId;
  previous.planningError = previous.previewAcceptanceError = 'Both prior frames were unsafe.';
  const identity = { sourceVideoMediaId: video.mediaId, sourceVideoContentHash: video.sha256,
    analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'gpt-6-luna') };
  const artifact = { key: `libraries/sha256/${sha('library')}.json`, sha256: sha('library'), byteLength: 100 };
  const library = { version: 1 as const, id: `video-library:${sha(`${video.mediaId}:${video.sha256}`)}` };
  const dependency = { version: 1 as const, identity, jobId: videoIntelligenceJobId(identity), completed: { artifact, library } };
  const intelligence = { identity, jobId: dependency.jobId, artifact,
    locator: { version: 1, sourceVideoMediaId: video.mediaId, sourceVideoContentHash: video.sha256, analyzerFingerprintSha256: identity.analyzerFingerprint.sha256 },
    library: { ...library, durationMs: 1000, analysisModels: { transcription: null, vision: ['gpt-6-luna'] },
      providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' },
    transcript: { status: 'NO_AUDIO_TRACK', model: null, language: null, totalSegmentCount: 0, coverage: 'COMPLETE', excerpts: [] },
    observationCoverage: { totalRepresentativeCount: 1, coverage: 'COMPLETE' },
    observations: [{ representativeOrdinal: 0, id: videoCandidateFrameId(video.sha256, 0, sha('frame')), timestampMs: 0,
      frameSha256: sha('frame'), evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', transcriptSegments: [],
      observation: { sceneType: 'PERSON', summary: 'A person', composition: 'Centered', visibleText: [], topics: ['person'], uncertainties: [] } }] };
  const entry = (source: typeof video | typeof layout, kind: string, result: unknown) => ({ source,
    analyzer: { kind, model: 'gpt-6-luna', schemaVersion: 1, contextSha256: kind === 'LAYOUT_ANGLE' ? sha(request.context) : null },
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result });
  previous.planning = { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, previewPreparedFrameCount: 2,
    videoDependencies: [dependency], sourceAnalysis: { version: 1, entries: [
      entry(video, 'VIDEO_INTELLIGENCE', { kind: 'VIDEO_INTELLIGENCE', intelligence }),
      entry(layout, 'LAYOUT_ANGLE', { kind: 'LAYOUT_ANGLE', angleDescription: 'Already paid angle' }),
      entry(layout, 'LAYOUT_BLUEPRINT', { kind: 'LAYOUT_BLUEPRINT', layout: { blueprint: referenceCandidate().blueprint,
        contentHash: layout.sha256, analyzerModel: 'gpt-6-luna', cacheHit: false } }),
    ] as any } } };
  Object.assign(fixture.approval, { id: 'new-approval', previousPortfolioId: oldId, portfolioId: newId,
    requestSha256: previewTestRequestHash(request), creativeIds: ['creative_' + 'e'.repeat(32), 'creative_' + 'f'.repeat(32)] });
  fixture.inventory.mockReset().mockResolvedValue([video, layout].map(identity => ({ identity, source: {} })));
  storage = new MemoryPortfolioStorage(); await storage.write(key(oldId), encode(previous), null);
  await storage.write('preview-test-calls/v1/old/frame-0.json', Buffer.from('old receipt'), null);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('copies frozen inputs with new identities and validated paid preparation while preserving the stopped run and receipts', async () => {
  const before = new Map([...storage.data].map(([key, value]) => [key, Buffer.from(value.bytes)]));
  const next = await initializeApprovedPreviewPortfolio(oldId, storage);
  expect(next.request).toEqual(previous.request); expect(next.id).toBe(newId);
  expect(next.slots.map(slot => slot.creativeId)).toEqual(fixture.approval.creativeIds);
  expect(next.planning).toMatchObject({ phase: 'INITIAL_PLAN', preparation: { quotaReserved: false,
    sourceAnalysis: previous.planning.phase === 'INITIAL_PLAN' ? previous.planning.preparation.sourceAnalysis : undefined } });
  expect(next).not.toHaveProperty('previewAcceptanceError'); expect(next).not.toHaveProperty('planningError');
  expect(next.planning).not.toHaveProperty('preparation.previewPreparedFrameCount');
  expect(await readCreativePortfolio(newId, storage)).toEqual(next);
  before.forEach((bytes, name) => expect(storage.data.get(name)?.bytes).toEqual(bytes));
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('reconciles concurrent creation and a lost acknowledgement without creating additional runs', async () => {
  const write = storage.write.bind(storage);
  vi.spyOn(storage, 'write').mockImplementationOnce(async (...args) => { await write(...args); throw Error('lost ack'); });
  const results = await Promise.all([initializeApprovedPreviewPortfolio(oldId, storage), initializeApprovedPreviewPortfolio(oldId, storage)]);
  expect(results[0]).toEqual(results[1]); expect(storage.data.size).toBe(3); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('returns an already stopped new run unchanged and never reinitializes it', async () => {
  const next = await initializeApprovedPreviewPortfolio(oldId, storage);
  next.previewAcceptanceError = 'New run stopped';
  const row = storage.data.get(key(newId))!; await storage.write(key(newId), encode(next), row.etag);
  fixture.inventory.mockRejectedValue(new Error('Must not revalidate or mutate existing run'));
  expect(await initializeApprovedPreviewPortfolio(oldId, storage)).toEqual(next);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each(['production', 'wrong-source', 'request', 'active-lease', 'not-stopped', 'missing-layout', 'changed-source', 'changed-model'])
('refuses %s before creating a run or purchasing replacement preparation', async change => {
  if (change === 'production') vi.stubEnv('VERCEL_ENV', 'production');
  if (change === 'request') previous.request.context += 'changed';
  if (change === 'active-lease') previous.lease = { id: 'active', slotIndex: null, expiresAtMs: 5000 };
  if (change === 'not-stopped') delete previous.previewAcceptanceError;
  if (change === 'missing-layout' && previous.planning.phase === 'INITIAL_PLAN') delete previous.planning.preparation.sourceAnalysis!.entries[1].result;
  if (change === 'changed-source') fixture.inventory.mockResolvedValue([]);
  if (change === 'changed-model') vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'changed-model');
  const row = storage.data.get(key(oldId))!; await storage.write(key(oldId), encode(previous), row.etag);
  await expect(initializeApprovedPreviewPortfolio(change === 'wrong-source' ? newId : oldId, storage)).rejects.toThrow();
  expect(storage.data.has(key(newId))).toBe(false); expect(globalThis.fetch).not.toHaveBeenCalled();
});
