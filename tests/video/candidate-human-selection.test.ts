import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';

const mocks = vi.hoisted(() => ({ neighbor: vi.fn() }));
vi.mock('@/lib/video/selection-context', async original => ({
  ...await original<typeof import('@/lib/video/selection-context')>(),
  loadVideoCandidateAnalysisImage: mocks.neighbor,
}));
import { advanceCandidateHumanSelection, planCandidateHumanSelection, planManualCandidateHumanSelection } from '@/lib/video/candidate-human-selection';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import { readCandidateSuitability } from '@/lib/video/candidate-suitability';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sourceHash = sha('video-original');
const mediaId = `media_${'a'.repeat(32)}`;
const libraryId = `video-library:${'b'.repeat(64)}`;
const librarySha256 = 'c'.repeat(64);
const preparationSha256 = 'd'.repeat(64);
const jpg = await Promise.all(['#a57755', '#816344', '#5577a5', '#6a8a53'].map((color) =>
  sharp({ create: { width: 96, height: 96, channels: 3, background: color } }).jpeg().toBuffer()));
const frame = (index: number, quality: number) => ({ candidateIndex: index, timestampMs: 1000 + index * 1000,
  frameSha256: sha(jpg[index]), width: 96, height: 96, extractionReasons: ['INTERVAL'],
  technical: { qualityScore: quality } });
const candidates = [frame(0, 100), frame(1, 80), frame(2, 70), frame(3, 60)];
const representativeId = (index: number) => videoCandidateFrameId(sourceHash,
  candidates[index].timestampMs, candidates[index].frameSha256);
const observation = (summary: string) => ({ sceneType: 'PERSON', topics: ['person'], summary,
  composition: 'Centered portrait', visibleText: [], uncertainties: [] });
const source = { role: 'TRA_VIDEO', media: { id: mediaId }, stored: { buffer: Buffer.from('video-original') } } as any;
const binding = (twoGroups = false) => {
  const representatives = [
    { id: representativeId(0), candidateIndex: 0, candidateIndexes: twoGroups ? [0, 1] : [0, 1, 2, 3],
      qualityScore: 100, timestampMs: candidates[0].timestampMs, observation: observation('Tax consultation portrait') },
    ...(twoGroups ? [{ id: representativeId(2), candidateIndex: 2, candidateIndexes: [2, 3],
      qualityScore: 70, timestampMs: candidates[2].timestampMs, observation: observation('Tax consultation portrait') }] : []),
  ];
  const library = { id: libraryId, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
    representativeFrames: representatives, candidates } as any;
  const context = { library, librarySha256, preparationSha256,
    manifest: { sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash, candidates,
      groups: representatives.map(item => ({ representativeIndex: item.candidateIndex, candidateIndexes: item.candidateIndexes })) },
    representativeImages: representatives.map((item) => ({ frameId: item.id, candidateIndex: item.candidateIndex,
      timestampMs: item.timestampMs, frameSha256: candidates[item.candidateIndex].frameSha256,
      width: 96, height: 96, bytes: jpg[item.candidateIndex] })) } as any;
  return [{ source, context }];
};
const assessment = (changes: Record<string, unknown> = {}) => ({ humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT',
  eyes: 'OPEN_OR_NOT_VISIBLE', blur: 'CLEAR', occlusion: 'NONE_OR_MINOR', expressionUsability: 'NATURAL_OR_NEUTRAL',
  framing: 'USABLE', observableReason: 'Visible person with usable portrait framing.',
  sourceOverlay: { status: 'CLEAN', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 }, ...changes });
const completed = (value: unknown) => Response.json({ status: 'completed', output: [{ content: [
  { type: 'output_text', text: JSON.stringify(value) },
] }] });
class MemoryStorage implements VideoIntelligenceStorage {
  values = new Map<string, { bytes: Buffer; etag: string }>(); count = 0;
  async read(key: string) { const item = this.values.get(key); return item ? { bytes: Buffer.from(item.bytes), etag: item.etag } : null; }
  async write(key: string, bytes: Buffer, etag: string | null) { const old = this.values.get(key);
    if (etag === null ? old : old?.etag !== etag) return false;
    this.values.set(key, { bytes: Buffer.from(bytes), etag: String(++this.count) }); return true; }
}
const setup = (...results: unknown[]) => {
  const storage = new MemoryStorage();
  const request = vi.fn<typeof fetch>().mockImplementation(async () => completed(results.shift()));
  return { storage, request, dependencies: { storage, request, deadlineAtMs: 300_000,
    now: () => 1_000, model: 'terra-test' } };
};
const reuse = (...frameIds: string[]) => ({ version: 1 as const, frames: frameIds.map((frameId) =>
  ({ libraryId, frameId, useCount: 1 })) });

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'offline-test-only');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected live provider call'); }));
  mocks.neighbor.mockReset().mockImplementation(async (_source, _context, index) => ({
    candidateIndex: index, frameSha256: candidates[index].frameSha256, bytes: jpg[index] }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const plan = (sources: ReturnType<typeof binding>, concept: string, used: ReturnType<typeof reuse>, state: ReturnType<typeof setup>) =>
  planCandidateHumanSelection(sources, concept, used, state.dependencies.model, state.dependencies);
const step = async (sources: ReturnType<typeof binding>, concept: string, used: ReturnType<typeof reuse>, state: ReturnType<typeof setup>) => {
  const next = await plan(sources, concept, used, state);
  return next.status === 'READY' ? advanceCandidateHumanSelection(next, state.dependencies) : next;
};

describe('bounded candidate human selection', () => {
  it('recovers a blinking representative through its same-group neighbor with exact provenance', async () => {
    const state = setup(assessment({ eyes: 'CLOSED_OR_BLINKING' }), assessment());
    const sources = binding();
    expect(await step(sources, 'Tax consultation portrait', reuse(), state)).toEqual({ status: 'CONTINUE' });
    expect(mocks.neighbor).not.toHaveBeenCalled();
    const recovered = await step(sources, 'Tax consultation portrait', reuse(), state);
    expect(recovered).toMatchObject({ status: 'COMPLETE', selection: { version: 3, libraryId,
      sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash, librarySha256,
      candidateBindings: [{ candidateIndex: 1, representativeFrameId: representativeId(0),
        frameId: representativeId(1), timestampMs: 2_000, frameSha256: candidates[1].frameSha256 }],
      sourceOverlays: [{ version: 2, status: 'CLEAN' }] } });
    expect(mocks.neighbor).toHaveBeenCalledOnce();
    expect(state.request).toHaveBeenCalledTimes(2);
    for (const [_, options] of state.request.mock.calls) {
      const body = JSON.parse(String(options!.body));
      expect(body.input[1].content.filter((part: { type: string }) => part.type === 'input_image')).toHaveLength(1);
      expect(body.max_output_tokens).toBe(2048);
      expect(JSON.stringify(body)).not.toContain('Tax consultation portrait');
    }
  });

  it('exhausts a bad group before trying another and prefers an unused viable group', async () => {
    const state = setup(assessment({ eyes: 'CLOSED_OR_BLINKING' }), assessment({ humanPresence: 'NONE' }), assessment());
    const sources = binding(true);
    expect((await step(sources, 'Tax consultation portrait', reuse(), state)).status).toBe('CONTINUE');
    expect((await step(sources, 'Tax consultation portrait', reuse(), state)).status).toBe('CONTINUE');
    expect(await step(sources, 'Tax consultation portrait', reuse(), state)).toMatchObject({ status: 'COMPLETE',
      selection: { candidateBindings: [{ representativeFrameId: representativeId(2), candidateIndex: 2 }] } });
    expect(state.request).toHaveBeenCalledTimes(3);
    const second = setup(assessment());
    second.storage = state.storage;
    second.dependencies.storage = state.storage;
    const used = reuse(representativeId(0));
    expect(await step(sources, 'Another tax consultation portrait', used, second)).toMatchObject({ status: 'COMPLETE',
      selection: { candidateBindings: [{ representativeFrameId: representativeId(2) }] } });
    expect(second.request).not.toHaveBeenCalled();
  });

  it('chooses an unused viable group before a cached suitable group already used in this portfolio', async () => {
    const state = setup(assessment(), assessment()); const sources = binding(true);
    expect((await step(sources, 'Tax consultation portrait', reuse(), state)).status).toBe('COMPLETE');
    const chosen = await step(sources, 'Tax consultation portrait', reuse(representativeId(0)), state);
    expect(chosen).toMatchObject({ status: 'COMPLETE', selection: {
      candidateBindings: [{ representativeFrameId: representativeId(2), candidateIndex: 2 }] } });
    expect(state.request).toHaveBeenCalledTimes(2);
  });

  it('reuses intrinsic assessment across concepts and invalidates each immutable binding', async () => {
    const state = setup(assessment()); const sources = binding();
    expect((await step(sources, 'Concept A', reuse(), state)).status).toBe('COMPLETE');
    expect((await plan(sources, 'Concept B', reuse(), state)).status).toBe('COMPLETE');
    expect(state.request).toHaveBeenCalledOnce();
    const first = await plan(sources, 'Concept C', reuse(), state);
    expect(first.status).toBe('COMPLETE');
    const identity = { policy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, model: 'terra-test',
      sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash, librarySha256, preparationSha256,
      representativeFrameId: representativeId(0), candidateIndex: 0,
      timestampMs: candidates[0].timestampMs, frameSha256: candidates[0].frameSha256 };
    for (const changed of [
      { sourceVideoContentHash: 'f'.repeat(64) }, { librarySha256: 'f'.repeat(64) },
      { preparationSha256: 'f'.repeat(64) }, { frameSha256: 'f'.repeat(64) },
      { timestampMs: 3000 }, { candidateIndex: 9 }, { model: 'different-model' },
    ]) expect(await readCandidateSuitability({ ...identity, ...changed }, state.dependencies)).toEqual({ status: 'MISSING' });
  });

  it('preserves the candidate-specific edge crop and excludes unsafe marks', async () => {
    const state = setup(assessment({ sourceOverlay: { status: 'UNSAFE', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 } }),
      assessment({ sourceOverlay: { status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 150, overlayDepthPermille: 120 } }));
    const sources = binding();
    expect((await step(sources, 'Tax consultation portrait', reuse(), state)).status).toBe('CONTINUE');
    expect(await step(sources, 'Tax consultation portrait', reuse(), state)).toMatchObject({ status: 'COMPLETE',
      selection: { candidateBindings: [{ candidateIndex: 1 }], sourceOverlays: [{ status: 'EDGE_CROP',
        edge: 'BOTTOM', removePermille: 150, overlayDepthPermille: 120 }] } });
  });

  it('sends only one relevant image from a large library', async () => {
    const unsafe = assessment({ sourceOverlay: { status: 'UNSAFE', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 } });
    const state = setup(...Array.from({ length: 6 }, () => unsafe));
    const sources = binding();
    const library = sources[0].context.library;
    library.candidates = Array.from({ length: 20 }, (_, candidateIndex) => ({ ...candidates[0], candidateIndex,
      timestampMs: 1000 + candidateIndex }));
    library.representativeFrames = library.candidates.map((candidate: any, index: number) => ({
      ...library.representativeFrames[0], id: videoCandidateFrameId(sourceHash, candidate.timestampMs, candidate.frameSha256),
      candidateIndex: index, candidateIndexes: [index], timestampMs: candidate.timestampMs,
      observation: observation(index ? 'Unrelated landscape' : 'Tax consultation portrait') }));
    sources[0].context.representativeImages = library.representativeFrames.map((item: any) => ({
      frameId: item.id, candidateIndex: item.candidateIndex, timestampMs: item.timestampMs, frameSha256: candidates[0].frameSha256,
      bytes: jpg[0], width: 96, height: 96 }));
    for (let index = 0; index < 6; index += 1) {
      expect((await step(sources, 'Tax consultation portrait', reuse(), state)).status).toBe('CONTINUE');
    }
    expect((await plan(sources, 'Tax consultation portrait', reuse(), state)).status).toBe('NO_SUITABLE_HUMAN');
    expect(state.request).toHaveBeenCalledTimes(6);
    const body = JSON.parse(String(state.request.mock.calls[0][1]!.body));
    expect(body.input[1].content.filter((part: { type: string }) => part.type === 'input_image')).toHaveLength(1);
    expect(body.max_output_tokens).toBe(2048);
  });
});

describe('manual candidate closed pool', () => {
  const manualBinding = (index: number) => ({ frameId: representativeId(index), representativeFrameId: representativeId(0),
    candidateIndex: index, timestampMs: candidates[index].timestampMs, frameSha256: candidates[index].frameSha256 });
  const manualStep = async (indexes: number[], state: ReturnType<typeof setup>, retry = false, used = reuse()) => {
    const next = await planManualCandidateHumanSelection(binding()[0], indexes.map(manualBinding), used,
      state.dependencies.model, { ...state.dependencies, retry });
    return next.status === 'READY' ? advanceCandidateHumanSelection(next, { ...state.dependencies, retry }) : next;
  };

  it('assesses an exact nonrepresentative outside automatic top alternatives and reuses it after reload', async () => {
    const state = setup(assessment({ sourceOverlay: { status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 150, overlayDepthPermille: 120 } }));
    expect(await manualStep([3], state)).toMatchObject({ status: 'COMPLETE', selection: {
      candidateBindings: [manualBinding(3)], sourceOverlays: [{ status: 'EDGE_CROP', removePermille: 150 }] } });
    expect(await manualStep([3], state)).toMatchObject({ status: 'COMPLETE' });
    expect(state.request).toHaveBeenCalledOnce(); expect(mocks.neighbor.mock.calls[0][2]).toBe(3);
  });

  it('uses the fourth manual candidate after three unsuitable candidates without truncation or widening', async () => {
    const state = setup(...Array.from({ length: 3 }, () => assessment({ humanPresence: 'NONE' })), assessment());
    for (let index = 0; index < 3; index++) expect(await manualStep([0, 1, 2, 3], state)).toEqual({ status: 'CONTINUE' });
    expect(await manualStep([0, 1, 2, 3], state)).toMatchObject({ status: 'COMPLETE', selection: { candidateBindings: [manualBinding(3)] } });
    expect(await manualStep([0, 1, 2, 3], state)).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(3)] } });
    expect(state.request).toHaveBeenCalledTimes(4);
    expect(mocks.neighbor.mock.calls.map(call => call[2])).toEqual([1, 2, 3]);
  });
  it('orders four suitable pool members by saved use counts and retains operator order on ties', async () => {
    const state = setup(...Array.from({ length: 4 }, () => assessment())); const used = reuse();
    for (let index = 0; index < 4; index++) {
      expect(await manualStep([0, 1, 2, 3], state, false, used)).toMatchObject({ status: 'COMPLETE', selection: { candidateBindings: [manualBinding(index)] } });
      used.frames.push({ libraryId, frameId: representativeId(index), useCount: 1 });
    }
    expect(await manualStep([3, 2, 1, 0], state, false, used)).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(3)] } });
    used.frames[3].useCount = 2;
    expect(await manualStep([3, 2, 1, 0], state, false, used)).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(2)] } });
    expect(state.request).toHaveBeenCalledTimes(4);
  });
  it('rejects an empty or duplicate manual pool before assessment', async () => {
    const state = setup(assessment());
    for (const indexes of [[], [0, 1, 2, 3, 0]]) await expect(manualStep(indexes, state)).rejects.toThrow('closed-pool');
    expect(state.request).not.toHaveBeenCalled();
  });
  it('never substitutes a suitable unselected representative or neighbor', async () => {
    const state = setup(assessment({ eyes: 'CLOSED_OR_BLINKING' }));
    expect(await manualStep([1], state)).toEqual({ status: 'CONTINUE' });
    expect(await manualStep([1], state)).toEqual({ status: 'NO_SUITABLE_HUMAN' });
    expect(state.request).toHaveBeenCalledOnce(); expect(mocks.neighbor).toHaveBeenCalledOnce();
  });

  it('tries only another manually selected frame after an unsafe assessment', async () => {
    const state = setup(assessment({ sourceOverlay: { status: 'UNSAFE', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 } }), assessment());
    expect(await manualStep([1, 3], state)).toEqual({ status: 'CONTINUE' });
    expect(await manualStep([1, 3], state)).toMatchObject({ status: 'COMPLETE', selection: { candidateBindings: [manualBinding(3)] } });
    expect(mocks.neighbor.mock.calls.map(call => call[2])).toEqual([1, 3]);
  });

  it('requires explicit Retry after failed assessment; Resume does not replay it', async () => {
    const state = setup(assessment()); state.request.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect(await manualStep([1], state)).toMatchObject({ status: 'RETRY_REQUIRED' });
    expect(await manualStep([1], state)).toMatchObject({ status: 'RETRY_REQUIRED' });
    expect(state.request).toHaveBeenCalledOnce();
    expect(await manualStep([1], state, true)).toMatchObject({ status: 'COMPLETE' });
    expect(state.request).toHaveBeenCalledTimes(2);
  });

  it('uses two suitable manual frames across creatives, then reuses cached assessments with the saved counts', async () => {
    const state = setup(assessment(), assessment());
    expect(await manualStep([0, 3], state)).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(0)] } });
    expect(await manualStep([0, 3], state, false, reuse(representativeId(0)))).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(3)] } });
    expect(state.request).toHaveBeenCalledTimes(2);
    const used = reuse(representativeId(0), representativeId(3)); used.frames[0].useCount = 2;
    expect(await manualStep([0, 3], state, false, used)).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(3)] } });
    expect(await manualStep([0, 3], state, false, { version: 1, frames: used.frames.map(item => ({ ...item, libraryId: 'other-library' })) }))
      .toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(0)] } });
    expect(state.request).toHaveBeenCalledTimes(2);
  });

  it('reuses the only suitable manual frame after rejecting an unused unsafe member', async () => {
    const state = setup(assessment(), assessment({ sourceOverlay: { status: 'UNSAFE', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 } }));
    expect((await manualStep([1], state)).status).toBe('COMPLETE');
    const used = reuse(representativeId(1));
    expect(await manualStep([1, 3], state, false, used)).toEqual({ status: 'CONTINUE' });
    expect(await manualStep([1, 3], state, false, used)).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(1)] } });
    expect(await manualStep([1], state, false, used)).toMatchObject({ status: 'COMPLETE' });
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(mocks.neighbor.mock.calls.map(call => call[2])).toEqual([1, 3]);
  });

  it('keeps saved reuse preference through failed assessment, Resume and explicit Retry', async () => {
    const state = setup(assessment(), assessment());
    await manualStep([0, 3], state);
    const used = reuse(representativeId(0));
    state.request.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect(await manualStep([0, 3], state, false, used)).toMatchObject({ status: 'RETRY_REQUIRED' });
    expect(await manualStep([0, 3], state, false, used)).toMatchObject({ status: 'RETRY_REQUIRED' });
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(await manualStep([0, 3], state, true, used)).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(3)] } });
    expect(await manualStep([0, 3], state, false, used)).toMatchObject({ status: 'COMPLETE', selection: { frameIds: [representativeId(3)] } });
    expect(state.request).toHaveBeenCalledTimes(3);
  });

  it.each(['candidateIndex', 'timestampMs', 'frameSha256', 'representativeFrameId'])('rejects %s drift before assessment', async field => {
    const state = setup(assessment()), selected = manualBinding(1);
    (selected as any)[field] = field.endsWith('Index') || field.endsWith('Ms') ? 999 : 'f'.repeat(64);
    await expect(planManualCandidateHumanSelection(binding()[0], [manualBinding(0), selected], reuse(),
      state.dependencies.model, state.dependencies)).rejects.toThrow('candidate and technical group');
    expect(state.request).not.toHaveBeenCalled(); expect(mocks.neighbor).not.toHaveBeenCalled();
  });
});
