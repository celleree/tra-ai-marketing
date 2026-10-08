import sharp from 'sharp';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
const mocks = vi.hoisted(() => ({ loadContext: vi.fn(), extractFrames: vi.fn() }));
vi.mock('@/lib/video/selection-context', () => ({ loadSavedVideoSelectionContext: mocks.loadContext, extractVideoSelectionFrames: mocks.extractFrames }));
import { createPortfolioVideoSelectionConcept, hydratePortfolioVideoFrameSelection, selectPortfolioVideoFrames, preflightPortfolioVideoFrames } from '@/lib/creatives/portfolio-video-selection';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const planned = (headline = 'Resolve the tax problem', fill = '') => ({ copy: { headline: fill || headline }, strategy: {
  hook: fill || 'Stop the notice cycle', painPoint: fill || 'Unresolved tax notices', desiredOutcome: fill || 'A clear path forward',
  conceptDetails: { mainMessage: fill || 'Understand the next step', proposition: fill || 'Get a clear resolution path',
    visualMechanism: fill || 'Notice to calm transition', subject: fill || 'Taxpayer reviewing a notice', environment: fill || 'Home kitchen' },
} }) as unknown as PlannedCreativeConcept;
const fullIdentity = (value: string) => value.match(/fullConceptSha256:([a-f0-9]{64})/)?.[1];
const row = (index: number) => {
  const buffer = Buffer.from(`video-${index}`), sourceVideoContentHash = sha(buffer), mediaId = `media_${index.toString(16).padStart(32, '0')}`;
  const libraryId = `video-library:${sha(`${mediaId}:${sourceVideoContentHash}`)}`, artifactSha = sha(`artifact-${index}`);
  const frame = (suffix: string) => ({ id: `video-frame:${sha(`frame-${index}-${suffix}`)}`, timestampMs: suffix === 'a' ? 100 : 200,
    qualityScore: 1, observation: { sceneType: 'OTHER', topics: ['other'], summary: `frame ${suffix}`, visibleText: [] }, transcriptSegments: [] });
  const library = { id: libraryId, version: 1, sourceVideoMediaId: mediaId, sourceVideoContentHash,
    representativeFrames: [frame('a'), frame('b')] } as unknown as VideoFrameLibrary;
  return { source: { role: 'TRA_VIDEO', media: { id: mediaId }, stored: { buffer } } as unknown as HydratedTraVideoSource, library,
    identity: { sourceVideoMediaId: mediaId, sourceVideoContentHash, analyzerFingerprint: { visionModel: 'b1-analyzer', sha256: sha('b1') } },
    artifact: { key: `libraries/sha256/${artifactSha}.json`, sha256: artifactSha, byteLength: 100 + index }, jobId: `video-intelligence:${sha(`job-${index}`)}` };
};
type Row = ReturnType<typeof row>;
const sourceAnalysis = (rows: Row[]) => ({ version: 1, entries: rows.map((item) => ({
  source: { role: 'TRA_VIDEO', mediaId: item.source.media.id, sha256: item.identity.sourceVideoContentHash },
  analyzer: { kind: 'VIDEO_INTELLIGENCE', model: 'b1-analyzer', schemaVersion: 1, contextSha256: null }, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
  result: { kind: 'VIDEO_INTELLIGENCE', intelligence: { identity: item.identity, jobId: item.jobId, artifact: item.artifact,
    library: { id: item.library.id, version: item.library.version } } },
})) }) as unknown as PlanningSourceAnalysisState;
class MemoryStorage implements VideoIntelligenceStorage {
  values = new Map<string, { bytes: Buffer; etag: string }>(); counter = 0;
  async read(key: string) { const item = this.values.get(key); return item ? { bytes: Buffer.from(item.bytes), etag: item.etag } : null; }
  async write(key: string, bytes: Buffer, expected: string | null) { const item = this.values.get(key); if (expected === null ? item : item?.etag !== expected) return false;
    this.values.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++this.counter}` }); return true; }
}
const setup = (rows: Row[], selected = rows[0]) => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key'); const storage = new MemoryStorage();
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text',
    text: JSON.stringify({ libraryId: selected!.library.id, frames: [{ frameId: selected!.library.representativeFrames[0].id, reason: 'Relevant visual.' }] }) }] }] }));
  mocks.loadContext.mockImplementation(async (source: HydratedTraVideoSource) => ({ library: rows.find((item) => item.source.media.id === source.media.id)!.library, manifest: null }));
  return { sourceAnalysis: sourceAnalysis(rows), sources: rows.map((item) => item.source), storage, request,
    cache: { model: 'explicit-selector-model', deadlineAtMs: 400_000, now: () => 1_000, newLeaseId: () => 'lease', storage, request } };
};
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('portfolio video selection adapter', () => {
  it('restores exact one/multi-video pools, preserves artifact SHA, uses explicit selector model, and supports silent metadata', async () => {
    const rows = [row(1), row(2)], state = setup(rows, rows[1]);
    const result = await selectPortfolioVideoFrames({ sourceAnalysis: state.sourceAnalysis, sources: state.sources,
      finalConcept: planned(), cache: state.cache });
    expect(result).toEqual({ status: 'COMPLETE', selection: { libraryId: rows[1].library.id,
      sourceVideoContentHash: rows[1].identity.sourceVideoContentHash, frameIds: [rows[1].library.representativeFrames[0].id] } });
    expect(mocks.loadContext.mock.calls.map((call) => call[1])).toEqual(rows.map((item) => ({ identity: item.identity, artifact: item.artifact })));
    const cacheRecord = JSON.parse([...state.storage.values.values()][0].bytes.toString());
    expect(cacheRecord.libraries.map((item: { librarySha256: string }) => item.librarySha256).sort()).toEqual(rows.map((item) => item.artifact.sha256).sort());
    const providerBody = JSON.parse(state.request.mock.calls[0][1]!.body as string);
    expect(providerBody.model).toBe('explicit-selector-model'); expect(providerBody.model).not.toBe('b1-analyzer');
    expect(providerBody.input[1].content[0].text).toContain('"temporalTranscriptContext":""');
    const single = setup([rows[0]]); expect((await selectPortfolioVideoFrames({ sourceAnalysis: single.sourceAnalysis, sources: single.sources,
      finalConcept: planned(), cache: single.cache })).status).toBe('COMPLETE');
  });

  it('builds a deterministic bounded readable identity from the full final concept', () => {
    const baseline = createPortfolioVideoSelectionConcept(planned());
    expect(baseline).toBe(createPortfolioVideoSelectionConcept(planned()));
    expect(baseline).toContain('portfolio-video-selection:v2');
    expect(baseline).toContain('headline: Resolve the tax problem');
    const common = 'a'.repeat(120), afterBoundaryA = createPortfolioVideoSelectionConcept(planned('x', `${common} first ending`));
    const afterBoundaryB = createPortfolioVideoSelectionConcept(planned('x', `${common} second ending`));
    expect(afterBoundaryA).not.toBe(afterBoundaryB);
    expect(fullIdentity(afterBoundaryA)).not.toBe(fullIdentity(afterBoundaryB));
    const lateA = planned(), lateB = structuredClone(lateA);
    lateA.strategy.conceptDetails!.environment = `${'shared environment '.repeat(20)}late alpha`;
    lateB.strategy.conceptDetails!.environment = `${'shared environment '.repeat(20)}late beta`;
    const lateIdentityA = createPortfolioVideoSelectionConcept(lateA), lateIdentityB = createPortfolioVideoSelectionConcept(lateB);
    expect(fullIdentity(lateIdentityA)).not.toBe(fullIdentity(lateIdentityB));
    const bounded = createPortfolioVideoSelectionConcept(planned('x', 'long useful context '.repeat(80)));
    expect(bounded.length).toBeLessThanOrEqual(2_000); expect(bounded).toContain('long useful context'); expect(bounded).toContain('…');
    expect(() => createPortfolioVideoSelectionConcept({ copy: { headline: 'x' }, strategy: { hook: 'x', painPoint: 'x', desiredOutcome: 'x' } } as unknown as PlannedCreativeConcept)).toThrow('missing frame-selection details');
  });

  it('passes BUSY through while the pooled cache owns the single provider request', async () => {
    const item = row(3), state = setup([item]); let finish!: (value: Response) => void; let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    state.request.mockImplementationOnce(() => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); });
    const input = { sourceAnalysis: state.sourceAnalysis, sources: state.sources, finalConcept: planned(), cache: state.cache };
    const owner = selectPortfolioVideoFrames(input); await began;
    expect(await selectPortfolioVideoFrames(input)).toEqual({ status: 'BUSY' });
    finish(Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ libraryId: item.library.id,
      frames: [{ frameId: item.library.representativeFrames[0].id, reason: 'Relevant.' }] }) }] }] }));
    expect((await owner).status).toBe('COMPLETE'); expect(state.request).toHaveBeenCalledTimes(1);
  });

  it('passes RETRY_REQUIRED through without replaying failed provider work', async () => {
    const state = setup([row(4)]); state.request.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const input = { sourceAnalysis: state.sourceAnalysis, sources: state.sources, finalConcept: planned(), cache: state.cache };
    expect(await selectPortfolioVideoFrames(input)).toEqual({ status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' });
    expect(await selectPortfolioVideoFrames(input)).toEqual({ status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' });
    expect(state.request).toHaveBeenCalledTimes(1);
  });

  it('hydrates only persisted frame IDs from the exact frozen dependency without provider selection', async () => {
    const rows = [row(5), row(6)], state = setup(rows), chosen = rows[1];
    const frameIds = chosen.library.representativeFrames.map((frame) => frame.id);
    const extracted = { exact: true, frames: frameIds.map(frameId => ({ frameId })) };
    mocks.extractFrames.mockResolvedValue(extracted); const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    expect(await hydratePortfolioVideoFrameSelection({ sourceAnalysis: state.sourceAnalysis, sources: state.sources,
      selection: { version: 2, libraryId: chosen.library.id, sourceVideoContentHash: chosen.identity.sourceVideoContentHash,
        frameIds, sourceOverlays: frameIds.map(() => ({ version: 2, status: 'CLEAN' })) } })).toMatchObject({ exact: true,
      frames: frameIds.map(frameId => ({ frameId, sourceOverlay: { version: 2, status: 'CLEAN' } })) });
    expect(mocks.loadContext).toHaveBeenCalledTimes(1); expect(mocks.loadContext.mock.calls[0][1]).toEqual({ identity: chosen.identity, artifact: chosen.artifact });
    expect(mocks.extractFrames.mock.calls[0][2]).toEqual(frameIds); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed for invalid pool/source/selection ownership and never falls back during hydration', async () => {
    const item = row(7), state = setup([item]), selection = { libraryId: item.library.id, sourceVideoContentHash: item.identity.sourceVideoContentHash,
      frameIds: [item.library.representativeFrames[0].id] };
    await expect(selectPortfolioVideoFrames({ ...state, finalConcept: planned(), sourceAnalysis: { version: 1, entries: [] } as PlanningSourceAnalysisState } as any)).rejects.toThrow('between 1 and 10');
    const staleSource = { ...item.source, stored: { ...item.source.stored, buffer: Buffer.from('changed') } } as HydratedTraVideoSource;
    await expect(selectPortfolioVideoFrames({ sourceAnalysis: state.sourceAnalysis, sources: [staleSource], finalConcept: planned(), cache: state.cache })).rejects.toThrow('does not match exactly one');
    await expect(hydratePortfolioVideoFrameSelection({ sourceAnalysis: state.sourceAnalysis, sources: state.sources,
      selection: { ...selection, libraryId: `video-library:${'f'.repeat(64)}` } })).rejects.toThrow('unknown or ambiguous');
    await expect(hydratePortfolioVideoFrameSelection({ sourceAnalysis: state.sourceAnalysis, sources: state.sources,
      selection: { ...selection, sourceVideoContentHash: 'f'.repeat(64) } })).rejects.toThrow('content hash');
    mocks.extractFrames.mockClear();
    await expect(hydratePortfolioVideoFrameSelection({ sourceAnalysis: state.sourceAnalysis, sources: state.sources,
      selection: { ...selection, frameIds: [`video-frame:${'f'.repeat(64)}`] } })).rejects.toThrow('unknown frame ID');
    mocks.loadContext.mockRejectedValueOnce(new Error('stale exact B1 context'));
    await expect(hydratePortfolioVideoFrameSelection({ sourceAnalysis: state.sourceAnalysis, sources: state.sources, selection })).rejects.toThrow('stale exact B1 context');
    expect(mocks.extractFrames).not.toHaveBeenCalled();
    const ambiguous = [row(8), row(9)], ambiguousAnalysis = sourceAnalysis(ambiguous) as any;
    ambiguousAnalysis.entries[1].result.intelligence.library.id = ambiguousAnalysis.entries[0].result.intelligence.library.id;
    await expect(selectPortfolioVideoFrames({ sourceAnalysis: ambiguousAnalysis, sources: ambiguous.map((entry) => entry.source), finalConcept: planned(), cache: state.cache })).rejects.toThrow('ambiguous source or library');
    const ten = Array.from({ length: 10 }, (_, index) => row(index + 20)), tenState = setup(ten);
    expect((await selectPortfolioVideoFrames({ sourceAnalysis: tenState.sourceAnalysis, sources: tenState.sources, finalConcept: planned(), cache: tenState.cache })).status).toBe('COMPLETE');
    const eleven = Array.from({ length: 11 }, (_, index) => row(index + 40));
    await expect(selectPortfolioVideoFrames({ sourceAnalysis: sourceAnalysis(eleven), sources: eleven.map((entry) => entry.source), finalConcept: planned(), cache: state.cache })).rejects.toThrow('between 1 and 10');
  });
});

const manualSetup = async () => {
  const item = row(80), other = row(81), state = setup([item, other]);
  const image = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#a57755' } }).jpeg().toBuffer();
  const sourceHash = item.identity.sourceVideoContentHash;
  const candidates = [0, 1].map(candidateIndex => ({ candidateIndex, timestampMs: candidateIndex * 1000,
    frameSha256: sha(image), width: 96, height: 96 }));
  const bindings = candidates.map(candidate => ({ ...candidate, frameId: videoCandidateFrameId(sourceHash, candidate.timestampMs, candidate.frameSha256),
    representativeFrameId: videoCandidateFrameId(sourceHash, 0, sha(image)) })).map(({ width: _w, height: _h, ...binding }) => binding);
  const library = { ...item.library, candidates, representativeFrames: [{ ...item.library.representativeFrames[0],
    id: bindings[0].frameId, candidateIndex: 0, candidateIndexes: [0, 1] }] };
  const context = { library, librarySha256: item.artifact.sha256, preparationSha256: sha('preparation'),
    manifest: { candidates, groups: [{ representativeIndex: 0, candidateIndexes: [0, 1] }] },
    representativeImages: [{ ...candidates[0], frameId: bindings[0].frameId, bytes: image }] };
  mocks.loadContext.mockResolvedValue(context);
  state.request.mockResolvedValue(Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
    humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE', blur: 'CLEAR',
    occlusion: 'NONE_OR_MINOR', expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE', observableReason: 'Usable portrait',
    sourceOverlay: { status: 'CLEAN', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 },
  }) }] }] }));
  const reviewChoices = { video: { libraryId: library.id, librarySha256: item.artifact.sha256, preparationSha256: context.preparationSha256,
    locator: { version: 1 as const, sourceVideoMediaId: item.source.media.id, sourceVideoContentHash: sourceHash,
      analyzerFingerprintSha256: item.identity.analyzerFingerprint.sha256 } }, frames: [bindings[0]], claims: null, companyProfile: null };
  const finalConcept = { ...planned(), strategy: { ...planned().strategy, execution: { subjectSource: 'approved-tra-human' } } } as PlannedCreativeConcept;
  return { ...state, finalConcept, reviewChoices, bindings, context, item };
};

it('selects only the reviewed source, checkpoints assessment, and hydrates exact manual bindings without provider replay', async () => {
  const input = await manualSetup();
  const selected = await selectPortfolioVideoFrames(input);
  expect(selected.status).toBe('COMPLETE'); if (selected.status !== 'COMPLETE') throw new Error('Missing selection');
  expect(selected.selection).toMatchObject({ version: 3, candidateBindings: [input.bindings[0]] });
  expect(mocks.loadContext).toHaveBeenCalledOnce(); expect(mocks.loadContext.mock.calls[0][0]).toBe(input.item.source);
  expect(await preflightPortfolioVideoFrames({ ...input, selectionPolicy: 'human-frame-candidate-suitability-v3',
    reuseContext: { version: 1, frames: [] } })).toEqual(selected);
  mocks.extractFrames.mockResolvedValue({ frames: [{ buffer: Buffer.from('fresh PNG') }], selectionProvenance: [] });
  const hydrated = await hydratePortfolioVideoFrameSelection({ ...input, selection: selected.selection });
  expect(mocks.extractFrames.mock.calls[0][2]).toEqual(input.reviewChoices.frames);
  expect(hydrated.frames[0]).toMatchObject({ sourceOverlay: { version: 2, status: 'CLEAN' } });
  expect(input.request).toHaveBeenCalledOnce();
  await expect(hydratePortfolioVideoFrameSelection({ ...input, reviewChoices: { ...input.reviewChoices, frames: [input.bindings[1]] },
    selection: selected.selection })).rejects.toThrow('closed-pool');
  expect(mocks.extractFrames).toHaveBeenCalledOnce();
});

it.each(['sourceVideoMediaId', 'sourceVideoContentHash', 'analyzerFingerprintSha256', 'librarySha256', 'preparationSha256'])
('rejects manual %s drift before assessment or extraction', async field => {
  const input = await manualSetup();
  if (field in input.reviewChoices.video.locator) (input.reviewChoices.video.locator as any)[field] = '9'.repeat(64);
  else (input.reviewChoices.video as any)[field] = '9'.repeat(64);
  await expect(selectPortfolioVideoFrames(input)).rejects.toThrow(/closed-pool/);
  expect(input.request).not.toHaveBeenCalled(); expect(mocks.extractFrames).not.toHaveBeenCalled();
});
