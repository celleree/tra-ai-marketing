import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeReferenceCreative, analyzeTraSourceCreative } from '@/lib/ai/openai';
import { analyzeApprovedTraVideoFrames } from '@/lib/ai/video-frame-generation';
import { advancePlanningSourceAnalysis as advance } from '@/lib/creatives/planning-source-composition';
import { getOrAnalyzeLayoutBlueprint } from '@/lib/layouts/service';
import type { MediaStorage } from '@/lib/media/storage';
import type { CreativeSourceSelection, StoredCreativeSourceMediaFile } from '@/lib/media/types';
import { getApprovedTraVideoFrames } from '@/lib/video/tra-video-frames';
import { REAL_ENCODED_MP4 } from '@/tests/fixtures/media';
import { referenceCandidate } from '@/tests/fixtures/reference-catalog';

vi.mock('@/lib/ai/openai', () => ({ analyzeReferenceCreative: vi.fn(), analyzeTraSourceCreative: vi.fn() }));
vi.mock('@/lib/layouts/service', () => ({ getOrAnalyzeLayoutBlueprint: vi.fn() }));
vi.mock('@/lib/video/tra-video-frames', () => ({ getApprovedTraVideoFrames: vi.fn() }));
vi.mock('@/lib/ai/video-frame-generation', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/ai/video-frame-generation')>(), analyzeApprovedTraVideoFrames: vi.fn(),
}));
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const analysis = { summary: 'Observed source', visibleText: [], visualStructure: '', hookOrAngle: 'An angle',
  offerOrCta: '', styleNotes: '', preserve: [], avoid: [], unknowns: [], dominantCategory: 'educational' as const };
function fixture(roles: CreativeSourceSelection['role'][] = ['TRA_REFERENCE']) {
  const sourceAssets = roles.map((role, i) => ({ role, mediaId: `media_${String(i + 1).repeat(32)}` }));
  const media: Record<string, StoredCreativeSourceMediaFile> = Object.fromEntries(sourceAssets.map(({ mediaId, role }) => [mediaId,
    role === 'TRA_VIDEO'
      ? { fileName: `${mediaId}.mp4`, buffer: Buffer.from(REAL_ENCODED_MP4), mimeType: 'video/mp4', mediaType: 'VIDEO' }
      : { fileName: `${mediaId}.png`, buffer: Buffer.from(png), mimeType: 'image/png', mediaType: 'IMAGE' }]));
  const storage = { readMediaById: vi.fn(async (id: string) => media[id] || null) } as unknown as MediaStorage;
  return { request: { sourceAssets, context: 'TRA context' }, media, storage, start: vi.fn() };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'test-analysis-model');
  vi.mocked(analyzeReferenceCreative).mockImplementation(async source => ({ ...analysis, hookOrAngle: source.fileName }));
  vi.mocked(analyzeTraSourceCreative).mockImplementation(async source => ({ ...analysis, summary: source.fileName }));
  vi.mocked(analyzeApprovedTraVideoFrames).mockImplementation(async ({ frames }) => ({ ...analysis, summary: frames[0].sourceVideoFileName }));
  vi.mocked(getOrAnalyzeLayoutBlueprint).mockImplementation(async (source, options) => ({
    blueprint: referenceCandidate().blueprint, contentHash: hash(source.buffer), analyzerModel: options!.analyzerModel!, cacheHit: false,
  }));
  vi.mocked(getApprovedTraVideoFrames).mockImplementation(async source => ({
    source: source as Awaited<ReturnType<typeof getApprovedTraVideoFrames>>['source'],
    sourceVideoContentHash: hash(source.stored.buffer), durationMs: 6000, reused: true,
    frames: Array.from({ length: 6 }, (_, frameIndex) => ({ frameIndex, timestampMs: frameIndex * 1000,
      buffer: png, mimeType: 'image/png', frameSha256: hash(png), byteLength: png.length, sourceRole: 'TRA_VIDEO',
      sourceVideoMediaId: source.media.id, sourceVideoFileName: source.media.fileName,
      sourceVideoContentHash: hash(source.stored.buffer), approvedHumanSource: true, cacheKey: null })),
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('incremental planning source analysis (unwired)', () => {
  it('retains mixed sources and repeated roles, with one operation per step and stable input ordering', async () => {
    const f = fixture(['TRA_VIDEO', 'TRA_REFERENCE', 'LAYOUT_REFERENCE', 'TRA_VIDEO', 'TRA_REFERENCE', 'LAYOUT_REFERENCE']);
    let next = await advance(f.request, undefined, f.start, f.storage);
    expect(next.state.entries).toHaveLength(10);
    expect(f.start).not.toHaveBeenCalled();
    expect(new Set(next.state.entries.map(entry => entry.source.mediaId)).size).toBe(6);
    const reverse = { ...f.request, sourceAssets: [...f.request.sourceAssets].reverse() };
    expect((await advance(reverse, undefined, f.start, f.storage)).state).toEqual(next.state);
    for (let i = 0; i < 10; i++) {
      const before = JSON.stringify(next.state);
      const previous = next.state;
      next = await advance(i % 2 ? reverse : f.request, previous, f.start, f.storage);
      expect(JSON.stringify(previous)).toBe(before);
      expect(f.start).toHaveBeenCalledTimes(i + 1);
      expect(next.state.entries.filter(entry => entry.result)).toHaveLength(i + 1);
      expect(next.complete).toBe(i === 9);
    }
    expect(analyzeApprovedTraVideoFrames).toHaveBeenCalledTimes(2);
    expect(analyzeTraSourceCreative).toHaveBeenCalledTimes(2);
    expect(analyzeReferenceCreative).toHaveBeenCalledTimes(2);
    expect(getOrAnalyzeLayoutBlueprint).toHaveBeenCalledTimes(4);
    for (const entry of next.state.entries) {
      expect(entry.source.sha256).toBe(hash(f.media[entry.source.mediaId].buffer));
      expect(entry.analyzer).toMatchObject({ kind: entry.result!.kind, model: 'test-analysis-model', schemaVersion: 1 });
      expect(entry.evidenceStatus).toBe('UNVERIFIED_MODEL_OBSERVATION');
      if (entry.result?.kind === 'TRA_REFERENCE' || entry.result?.kind === 'REPRESENTATIVE_VIDEO_FRAMES') {
        expect(entry.result.analysis.summary).toBe(f.media[entry.source.mediaId].fileName);
      }
      if (entry.result?.kind === 'LAYOUT_ANGLE') expect(entry.result.angleDescription).toBe(f.media[entry.source.mediaId].fileName);
      if (entry.result?.kind === 'REPRESENTATIVE_VIDEO_FRAMES') {
        expect(entry.result.analyzedFrames.map(frame => frame.timestampMs)).toEqual([0, 2000, 5000]);
        expect(entry.result.analyzedFrames.every(frame => frame.frameSha256 === hash(png))).toBe(true);
      }
    }
    const serialized = JSON.stringify(next.state);
    expect(serialized).not.toMatch(/buffer|approvedHumanSource|libraryId/);
    const reused = await advance(reverse, JSON.parse(serialized), f.start, f.storage);
    expect(reused).toEqual(next);
    expect(f.start).toHaveBeenCalledTimes(10);
  });

  it.each(['missing', 'bytes', 'role', 'removed', 'added', 'context', 'model', 'identity'] as const)(
    'rejects %s changes even after completion, without another operation', async change => {
      const f = fixture();
      let next = await advance(f.request, undefined, f.start, f.storage);
      while (!next.complete) next = await advance(f.request, next.state, f.start, f.storage);
      const saved = JSON.stringify(next.state);
      const id = f.request.sourceAssets[0].mediaId;
      if (change === 'missing') delete f.media[id];
      if (change === 'bytes') f.media[id].buffer = Buffer.concat([png, Buffer.from('changed')]);
      if (change === 'role') f.request.sourceAssets[0].role = 'LAYOUT_REFERENCE';
      if (change === 'removed') f.request.sourceAssets = [];
      if (change === 'added') {
        const extra = `media_${'f'.repeat(32)}`;
        f.media[extra] = { ...f.media[id], fileName: `${extra}.png` };
        f.request.sourceAssets.push({ mediaId: extra, role: 'TRA_REFERENCE' });
      }
      if (change === 'context') f.request.context = 'Changed context';
      if (change === 'model') vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'changed-model');
      if (change === 'identity') next.state.entries[0].analyzer.contextSha256 = '0'.repeat(64);
      await expect(advance(f.request, next.state, f.start, f.storage)).rejects.toMatchObject({ status: change === 'missing' ? 404 : 409 });
      expect(f.start).toHaveBeenCalledTimes(2);
      if (change !== 'identity') expect(JSON.stringify(next.state)).toBe(saved);
    });

  it('propagates uncertain provider failure without retry or mutating the checkpoint', async () => {
    const f = fixture();
    const { state } = await advance(f.request, undefined, f.start, f.storage);
    vi.mocked(analyzeTraSourceCreative).mockRejectedValueOnce(new Error('uncertain paid outcome'));
    await expect(advance(f.request, state, f.start, f.storage)).rejects.toThrow('uncertain paid outcome');
    expect(state.entries.every(entry => !entry.result)).toBe(true);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(analyzeTraSourceCreative).toHaveBeenCalledTimes(1);
    expect(getOrAnalyzeLayoutBlueprint).not.toHaveBeenCalled();
  });

  it('rejects duplicate IDs and incompatible stored media before provider work', async () => {
    const f = fixture();
    f.request.sourceAssets.push(f.request.sourceAssets[0]);
    await expect(advance(f.request, undefined, f.start, f.storage)).rejects.toMatchObject({ status: 400 });
    f.request.sourceAssets = [{ ...f.request.sourceAssets[0], role: 'TRA_VIDEO' }];
    await expect(advance(f.request, undefined, f.start, f.storage)).rejects.toMatchObject({ status: 400 });
    expect(f.start).not.toHaveBeenCalled();
  });

  it('rejects mismatched extracted frame provenance before provider work', async () => {
    const f = fixture(['TRA_VIDEO']);
    const { state } = await advance(f.request, undefined, f.start, f.storage);
    const original = vi.mocked(getApprovedTraVideoFrames).getMockImplementation()!;
    vi.mocked(getApprovedTraVideoFrames).mockImplementationOnce(async source => {
      const extracted = await original(source);
      extracted.frames.forEach(frame => { frame.sourceVideoMediaId = `media_${'f'.repeat(32)}`; });
      return extracted;
    });
    await expect(advance(f.request, state, f.start, f.storage)).rejects.toMatchObject({ status: 409 });
    expect(f.start).not.toHaveBeenCalled();
    expect(analyzeApprovedTraVideoFrames).not.toHaveBeenCalled();
  });
});
