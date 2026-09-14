import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
const mocks = vi.hoisted(() => ({ loadContext: vi.fn(), extractFrames: vi.fn() }));
vi.mock('@/lib/video/selection-context', () => ({ loadSavedVideoSelectionContext: mocks.loadContext, extractVideoSelectionFrames: mocks.extractFrames }));
import { createPortfolioVideoSelectionConcept, hydratePortfolioVideoFrameSelection, selectPortfolioVideoFrames } from '@/lib/creatives/portfolio-video-selection';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const planned = (headline = 'Resolve the tax problem', fill = '') => ({ copy: { headline: fill || headline }, strategy: {
  hook: fill || 'Stop the notice cycle', painPoint: fill || 'Unresolved tax notices', desiredOutcome: fill || 'A clear path forward',
  conceptDetails: { mainMessage: fill || 'Understand the next step', proposition: fill || 'Get a clear resolution path',
    visualMechanism: fill || 'Notice to calm transition', subject: fill || 'Taxpayer reviewing a notice', environment: fill || 'Home kitchen' },
} }) as unknown as PlannedCreativeConcept;
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

  it('builds a deterministic bounded identity only from required final concept fields', () => {
    expect(createPortfolioVideoSelectionConcept(planned())).toBe(createPortfolioVideoSelectionConcept(planned()));
    expect(createPortfolioVideoSelectionConcept(planned('Changed headline'))).not.toBe(createPortfolioVideoSelectionConcept(planned()));
    expect(createPortfolioVideoSelectionConcept(planned('x', '"\\'.repeat(800))).length).toBeLessThanOrEqual(2_000);
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
    const frameIds = chosen.library.representativeFrames.map((frame) => frame.id); const extracted = { exact: true };
    mocks.extractFrames.mockResolvedValue(extracted); const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    expect(await hydratePortfolioVideoFrameSelection({ sourceAnalysis: state.sourceAnalysis, sources: state.sources,
      selection: { libraryId: chosen.library.id, sourceVideoContentHash: chosen.identity.sourceVideoContentHash, frameIds } })).toBe(extracted);
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
