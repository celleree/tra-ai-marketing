import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { HUMAN_FRAME_SELECTION_POLICY, selectVideoHumanFrameFromPool, type VideoHumanFrameAssessment,
  type VideoHumanSelectionPoolBinding, visualSelectionOutputTokens } from '@/lib/video/human-frame-selection';
import { selectVideoFramesFromPoolWithCache, selectVideoHumanFrameFromPoolWithCache } from '@/lib/video/selection-cache';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const jpegA = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#c69c6d' } }).jpeg().toBuffer();
const jpegB = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#6d9cc6' } }).jpeg().toBuffer();
const tallJpeg = await sharp({ create: { width: 1_280, height: 2_276, channels: 3, background: '#777777' } }).jpeg().toBuffer();
const sourceHash = sha('video');
const frame = (id: string, candidateIndex: number, bytes: Buffer, qualityScore: number) => ({
  id, candidateIndexes: [candidateIndex], candidateIndex, timestampMs: 1_000 + candidateIndex * 1_000,
  frameSha256: sha(bytes), qualityScore, thumbnailDataUrl: `data:image/jpeg;base64,thumbnail-${id}`,
  evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const,
  observation: { sceneType: 'PERSON' as const, summary: 'A person in a simple setting.', composition: 'Centered portrait.',
    visibleText: [], topics: ['person' as const], uncertainties: [] }, transcriptSegments: [],
});
const library = (() => {
  const frames = [frame('frame-sharp-blink', 0, jpegA, 100), frame('frame-usable', 1, jpegB, 1)];
  return { version: 1, id: 'library-visual', providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
    sourceVideoMediaId: 'media-video', sourceVideoContentHash: sourceHash, durationMs: 4_000,
    analysisModels: { transcription: 'whisper-1', vision: ['vision'] },
    transcript: { version: 1, model: 'whisper-1', language: 'en', segments: [] },
    candidates: frames.map((item, index) => ({ candidateIndex: index, timestampMs: item.timestampMs, width: 96, height: 96,
      extractionReasons: ['INTERVAL'], frameSha256: item.frameSha256, technical: {} })),
    representativeFrames: frames, semanticGroups: { sceneTypes: [], topics: [] },
  } as unknown as VideoFrameLibrary;
})();
const binding = (): VideoHumanSelectionPoolBinding => ({ library, librarySha256: sha('library-artifact'), representativeImages: [
  { frameId: 'frame-sharp-blink', candidateIndex: 0, timestampMs: 1_000, frameSha256: sha(jpegA), width: 96, height: 96, bytes: jpegA },
  { frameId: 'frame-usable', candidateIndex: 1, timestampMs: 2_000, frameSha256: sha(jpegB), width: 96, height: 96, bytes: jpegB },
] });
const lowResolutionBinding = (imageCount: number): VideoHumanSelectionPoolBinding => {
  const frames = Array.from({ length: imageCount }, (_, index) => frame(`frame-${index}`, index, jpegA, index));
  const lowResolutionLibrary = { ...library, candidates: frames.map((item, index) => ({ candidateIndex: index,
    timestampMs: item.timestampMs, width: 96, height: 96, extractionReasons: ['INTERVAL'],
    frameSha256: item.frameSha256, technical: {} })), representativeFrames: frames } as unknown as VideoFrameLibrary;
  return { library: lowResolutionLibrary, librarySha256: sha(`low-resolution-${imageCount}`), representativeImages: frames.map((item) => ({
    frameId: item.id, candidateIndex: item.candidateIndex, timestampMs: item.timestampMs, frameSha256: item.frameSha256,
    width: 96, height: 96, bytes: jpegA,
  })) };
};
const visualCacheIdentity = (input: VideoHumanSelectionPoolBinding, concept: string, model: string) => {
  const libraries = [{ libraryId: input.library.id, sourceVideoMediaId: input.library.sourceVideoMediaId,
    sourceVideoContentHash: input.library.sourceVideoContentHash, librarySha256: input.librarySha256,
    frames: input.representativeImages.map(({ bytes: _bytes, ...identity }) => identity) }];
  const digest = sha(JSON.stringify([3, HUMAN_FRAME_SELECTION_POLICY, libraries, emptyReuse, concept, model]));
  return { libraries, key: `selections/sha256/${digest}.json` };
};
const assessment = (frameId: string, overrides: Partial<VideoHumanFrameAssessment> = {}): VideoHumanFrameAssessment => ({
  libraryId: library.id, frameId, humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE',
  blur: 'CLEAR', occlusion: 'NONE_OR_MINOR', expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE',
  compositionFit: 'STRONG', observableReason: `Observable quality for ${frameId}.`, ...overrides,
  sourceOverlay: overrides.sourceOverlay ?? { version: 2, status: 'CLEAN' },
});
const completed = (assessments: VideoHumanFrameAssessment[]) => Response.json({ status: 'completed', output: [{ content: [
  { type: 'output_text', text: JSON.stringify({ assessments }) },
] }] });
const emptyReuse = { version: 1 as const, frames: [] };

class MemoryStorage implements VideoIntelligenceStorage {
  values = new Map<string, { bytes: Buffer; etag: string }>(); counter = 0;
  async read(key: string) { const item = this.values.get(key); return item ? { bytes: Buffer.from(item.bytes), etag: item.etag } : null; }
  async write(key: string, bytes: Buffer, expected: string | null) { const item = this.values.get(key);
    if (expected === null ? item : item?.etag !== expected) return false;
    this.values.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++this.counter}` }); return true; }
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected live provider request'); })));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('visual human-frame selection', () => {
  it('sends every source-bound full JPEG as a high-detail image and rejects a sharp blinking frame', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy');
    const request = vi.fn<typeof fetch>().mockResolvedValue(completed([
      assessment('frame-sharp-blink', { eyes: 'CLOSED_OR_BLINKING', observableReason: 'Eyes visibly closed.' }),
      assessment('frame-usable', { blur: 'MODERATE', observableReason: 'Open eyes and usable framing.' }),
    ]));
    const outcome = await selectVideoHumanFrameFromPool([binding()], 'Human portrait', emptyReuse, { request, model: 'test-model' });
    expect(outcome).toMatchObject({ status: 'SELECTED', selection: { frames: [{ frameId: 'frame-usable' }] } });
    expect(fetch).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(request.mock.calls[0][1]!.body as string);
    expect(JSON.parse(body.input[1].content[1].text)).toMatchObject({ libraryId: library.id, frameId: 'frame-sharp-blink' });
    expect(JSON.parse(body.input[1].content[3].text)).toMatchObject({ libraryId: library.id, frameId: 'frame-usable' });
    const images = body.input[1].content.filter((part: { type: string }) => part.type === 'input_image');
    expect(images).toEqual([
      { type: 'input_image', image_url: `data:image/jpeg;base64,${jpegA.toString('base64')}`, detail: 'high' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${jpegB.toString('base64')}`, detail: 'high' },
    ]);
    expect(JSON.stringify(body)).not.toContain('thumbnail-frame');
    expect(body.text.format.schema.properties.assessments).toMatchObject({ minItems: 2, maxItems: 2 });
  });

  it('rejects incomplete or duplicated assessments instead of inventing a selection', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy');
    const request = vi.fn<typeof fetch>().mockResolvedValue(completed([assessment('frame-usable')]));
    await expect(selectVideoHumanFrameFromPool([binding()], 'Portrait', emptyReuse, { request }))
      .rejects.toThrow('assess every candidate');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets visual assessments change ranking and uses reuse only among equally suitable frames', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy');
    const responses = [
      completed([assessment('frame-sharp-blink', { compositionFit: 'ACCEPTABLE' }), assessment('frame-usable')]),
      completed([assessment('frame-sharp-blink'), assessment('frame-usable')]),
      completed([assessment('frame-sharp-blink'), assessment('frame-usable', { compositionFit: 'ACCEPTABLE' })]),
    ];
    const request = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
    const first = await selectVideoHumanFrameFromPool([binding()], 'Portrait', emptyReuse, { request });
    expect(first).toMatchObject({ status: 'SELECTED', selection: { frames: [{ frameId: 'frame-usable' }] } });
    const reuse = { version: 1 as const, frames: [{ libraryId: library.id, frameId: 'frame-sharp-blink', useCount: 1 }] };
    const equalQuality = await selectVideoHumanFrameFromPool([binding()], 'Portrait', reuse, { request });
    expect(equalQuality).toMatchObject({ status: 'SELECTED', selection: { frames: [{ frameId: 'frame-usable' }] } });
    const qualityFirst = await selectVideoHumanFrameFromPool([binding()], 'Portrait', reuse, { request });
    expect(qualityFirst).toMatchObject({ status: 'SELECTED', selection: { frames: [{ frameId: 'frame-sharp-blink' }] } });
  });

  it('returns an explicit no-suitable outcome and rejects stale image bindings before HTTP', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy');
    const request = vi.fn<typeof fetch>().mockResolvedValue(completed([
      assessment('frame-sharp-blink', { eyes: 'CLOSED_OR_BLINKING' }),
      assessment('frame-usable', { facialDetail: 'INSUFFICIENT' }),
    ]));
    await expect(selectVideoHumanFrameFromPool([binding()], 'Portrait', emptyReuse, { request }))
      .resolves.toMatchObject({ status: 'NO_SUITABLE_HUMAN', assessments: expect.any(Array) });
    const stale = binding(); stale.representativeImages = [{ ...stale.representativeImages[0], bytes: jpegB }, stale.representativeImages[1]];
    request.mockClear();
    await expect(selectVideoHumanFrameFromPool([stale], 'Portrait', emptyReuse, { request })).rejects.toThrow('binding is invalid');
    expect(request).not.toHaveBeenCalled();
  });

  it('skips a contaminated unsafe candidate and persists a bounded removable-edge decision for the winner', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy');
    const request = vi.fn<typeof fetch>().mockResolvedValue(completed([
      assessment('frame-sharp-blink', { sourceOverlay: { version: 2, status: 'UNSAFE' } }),
      assessment('frame-usable', { sourceOverlay: { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM',
        removePermille: 400, overlayDepthPermille: 390 } }),
    ]));
    const result = await selectVideoHumanFrameFromPool([binding()], 'Portrait', emptyReuse, { request });
    expect(result).toMatchObject({ status: 'SELECTED', selection: { frames: [{ frameId: 'frame-usable' }] },
      selectedSourceOverlay: { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 400 } });
    expect(request).toHaveBeenCalledOnce();
  });

  it('normalizes the actual strict response shape into a versioned crop decision', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy');
    const assessments = [assessment('frame-sharp-blink', { eyes: 'CLOSED_OR_BLINKING' }),
      assessment('frame-usable')].map(item => ({ ...item, sourceOverlay: item.frameId === 'frame-usable'
        ? { status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 400, overlayDepthPermille: 390 }
        : { status: 'CLEAN', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 } }));
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'completed', output: [
      { content: [{ type: 'output_text', text: JSON.stringify({ assessments }) }] },
    ] }));
    const result = await selectVideoHumanFrameFromPool([binding()], 'Portrait', emptyReuse, { request });
    expect(result).toMatchObject({ status: 'SELECTED', selectedSourceOverlay: { version: 2, status: 'EDGE_CROP',
      edge: 'BOTTOM', removePermille: 400, overlayDepthPermille: 390 } });
  });

  it('rejects the whole over-budget pool instead of silently truncating candidates', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy'); const request = vi.fn<typeof fetch>();
    const frames = Array.from({ length: 81 }, (_, index) => frame(`frame-${index}`, index, tallJpeg, index));
    const oversizedLibrary = { ...library, candidates: frames.map((item, index) => ({ candidateIndex: index,
      timestampMs: item.timestampMs, width: 1_280, height: 2_276, extractionReasons: ['INTERVAL'],
      frameSha256: item.frameSha256, technical: {} })), representativeFrames: frames } as unknown as VideoFrameLibrary;
    const oversized = { library: oversizedLibrary, librarySha256: sha('oversized'), representativeImages: frames.map((item) => ({
      frameId: item.id, candidateIndex: item.candidateIndex, timestampMs: item.timestampMs, frameSha256: item.frameSha256,
      width: 1_280, height: 2_276, bytes: tallJpeg,
    })) };
    await expect(selectVideoHumanFrameFromPool([oversized], 'Portrait', emptyReuse, { request }))
      .rejects.toThrow('No candidates were truncated');
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the calculated output allowance and rejects whole low-resolution pools above it before direct or cached work', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy');
    const admitted = lowResolutionBinding(787);
    const request = vi.fn<typeof fetch>().mockResolvedValue(completed(admitted.library.representativeFrames.map((item) => assessment(item.id))));
    await expect(selectVideoHumanFrameFromPool([admitted], 'Portrait', emptyReuse, { request })).resolves.toMatchObject({ status: 'SELECTED' });
    expect(visualSelectionOutputTokens(787)).toBe(127_968);
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).max_output_tokens).toBe(127_968);

    for (const [imageCount, required] of [[788, 128_128], [1_000, 162_048]] as const) {
      const rejected = lowResolutionBinding(imageCount);
      const storage = new MemoryStorage();
      const deps = { storage, model: 'frozen-model', deadlineAtMs: 400_000, now: () => 1_000, request };
      request.mockClear();
      await expect(selectVideoHumanFrameFromPool([rejected], 'Portrait', emptyReuse, { request }))
        .rejects.toThrow(`requires ${required} output tokens`);
      await expect(selectVideoHumanFrameFromPoolWithCache([rejected], 'Portrait', emptyReuse, deps))
        .rejects.toThrow(`requires ${required} output tokens`);
      const retryStorage = new MemoryStorage();
      const { libraries, key } = visualCacheIdentity(rejected, 'Portrait', 'frozen-model');
      retryStorage.values.set(key, { etag: 'retry-required', bytes: Buffer.from(JSON.stringify({ version: 3,
        policy: HUMAN_FRAME_SELECTION_POLICY, libraries, reuseContext: emptyReuse, model: 'frozen-model', concept: 'Portrait',
        status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' })) });
      await expect(selectVideoHumanFrameFromPoolWithCache([rejected], 'Portrait', emptyReuse, { ...deps, storage: retryStorage, retry: true }))
        .rejects.toThrow(`requires ${required} output tokens`);
      expect(request).not.toHaveBeenCalled();
      expect(storage.values.size).toBe(0);
      expect(JSON.parse(retryStorage.values.get(key)!.bytes.toString('utf8')).status).toBe('RETRY_REQUIRED');
    }
  });

  it('keeps a completed historical visual cache result reusable when output admission later tightens', async () => {
    const historical = lowResolutionBinding(788); const storage = new MemoryStorage();
    const concept = 'Portrait', model = 'frozen-model';
    const { libraries, key } = visualCacheIdentity(historical, concept, model);
    storage.values.set(key, { etag: 'historical', bytes: Buffer.from(JSON.stringify({
      version: 3, policy: HUMAN_FRAME_SELECTION_POLICY, libraries, reuseContext: emptyReuse, model, concept, status: 'COMPLETE',
      outcome: { status: 'SELECTED', selection: { version: 1, libraryId: historical.library.id,
        sourceVideoMediaId: historical.library.sourceVideoMediaId, sourceVideoContentHash: historical.library.sourceVideoContentHash,
        concept, providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_SELECTION',
        frames: [{ frameId: historical.library.representativeFrames[0].id, reason: 'Historical completed assessment.' }] },
      assessments: historical.library.representativeFrames.map((item) => assessment(item.id)) },
    })) });
    const request = vi.fn<typeof fetch>();
    await expect(selectVideoHumanFrameFromPoolWithCache([historical], concept, emptyReuse, {
      storage, model, deadlineAtMs: 400_000, now: () => 1_000, request,
    })).resolves.toMatchObject({ status: 'COMPLETE', outcome: { status: 'SELECTED' } });
    expect(request).not.toHaveBeenCalled();
  });

  it('invalidates metadata-only and changed-reuse cache identities while warming exact visual decisions', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy'); const storage = new MemoryStorage();
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string); const hasImages = body.input[1].content.some((part: { type: string }) => part.type === 'input_image');
      return hasImages ? completed([assessment('frame-sharp-blink'), assessment('frame-usable')])
        : Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
          libraryId: library.id, frames: [{ frameId: 'frame-sharp-blink', reason: 'Metadata choice.' }],
        }) }] }] });
    });
    const deps = { storage, model: 'frozen-model', deadlineAtMs: 400_000, now: () => 1_000, request };
    await selectVideoFramesFromPoolWithCache([{ library, librarySha256: binding().librarySha256 }], 'Portrait', deps);
    const cold = await selectVideoHumanFrameFromPoolWithCache([binding()], 'Portrait', emptyReuse, deps);
    expect(request).toHaveBeenCalledTimes(2); expect(storage.values.size).toBe(2);
    expect(await selectVideoHumanFrameFromPoolWithCache([binding()], 'Portrait', emptyReuse, deps)).toEqual(cold);
    expect(request).toHaveBeenCalledTimes(2);
    await selectVideoHumanFrameFromPoolWithCache([binding()], 'Portrait', {
      version: 1, frames: [{ libraryId: library.id, frameId: 'frame-sharp-blink', useCount: 1 }],
    }, deps);
    expect(request).toHaveBeenCalledTimes(3); expect(storage.values.size).toBe(3);
    await selectVideoHumanFrameFromPoolWithCache([binding()], 'Portrait', emptyReuse, { ...deps, model: 'changed-model' });
    const changedArtifact = binding(); changedArtifact.librarySha256 = sha('changed-library-artifact');
    await selectVideoHumanFrameFromPoolWithCache([changedArtifact], 'Portrait', emptyReuse, deps);
    expect(request).toHaveBeenCalledTimes(5); expect(storage.values.size).toBe(5);
  });

  it('keeps visual provider failure and deadline states behind explicit Retry', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy'); const storage = new MemoryStorage();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(completed([assessment('frame-sharp-blink'), assessment('frame-usable')]));
    const deps = { storage, model: 'frozen-model', deadlineAtMs: 400_000, now: () => 1_000, request };
    await expect(selectVideoHumanFrameFromPoolWithCache([binding()], 'Portrait', emptyReuse, deps))
      .resolves.toEqual({ status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' });
    await selectVideoHumanFrameFromPoolWithCache([binding()], 'Portrait', emptyReuse, deps);
    expect(request).toHaveBeenCalledTimes(1);
    await expect(selectVideoHumanFrameFromPoolWithCache([binding()], 'Portrait', emptyReuse, { ...deps, retry: true }))
      .resolves.toMatchObject({ status: 'COMPLETE' });
    expect(request).toHaveBeenCalledTimes(2);
    const shortRequest = vi.fn<typeof fetch>();
    await expect(selectVideoHumanFrameFromPoolWithCache([binding()], 'Short deadline', emptyReuse, {
      ...deps, storage: new MemoryStorage(), request: shortRequest, deadlineAtMs: 185_999,
    })).resolves.toEqual({ status: 'RETRY_REQUIRED', reason: 'INSUFFICIENT_TIME' });
    expect(shortRequest).not.toHaveBeenCalled();
  });
});
