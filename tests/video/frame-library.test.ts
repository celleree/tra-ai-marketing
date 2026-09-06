import { describe, expect, it } from 'vitest';
import { assembleVideoFrameLibrary } from '@/lib/video/frame-library';
import type { TemporaryVideoFrameCandidate, TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';
import type { FrameTechnicalAnalysis } from '@/lib/video/frame-technical-analysis';
import type { VideoTranscript } from '@/lib/video/transcript';
import sharp from 'sharp';

const sourceVideoMediaId = 'media-video-1';
const sourceVideoContentHash = 'a'.repeat(64);
const JPEG_DATA_URL = `data:image/jpeg;base64,${(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#888888' } }).jpeg().toBuffer()).toString('base64')}`;
const technical = (score: number): FrameTechnicalAnalysis => ({ version: 1, analysisWidth: 1, analysisHeight: 1,
  differenceHash: '0'.repeat(16), meanRgb: [1, 2, 3], meanLuminance: 2, luminanceDeviation: 1,
  laplacianVariance: 1, darkFraction: 0, lightFraction: 0, qualityScore: score });
const candidate = (candidateIndex: number, timestampMs: number): TemporaryVideoFrameCandidate => ({
  candidateIndex, timestampMs, sourceRole: 'TRA_VIDEO', sourceVideoMediaId, sourceVideoFileName: 'source.mp4', sourceVideoContentHash,
  mimeType: 'image/jpeg', width: 640, height: 360, byteLength: 123, frameSha256: `${candidateIndex}`.padStart(64, '0'),
  extractionReasons: ['INTERVAL'], temporaryPath: `/tmp/frame-${candidateIndex}.jpg`, lifecycle: 'TEMPORARY', providerEligible: false,
});
const set = (): TemporaryVideoFrameCandidateSet => ({ sourceVideoMediaId, sourceVideoFileName: 'source.mp4', sourceVideoContentHash,
  durationMs: 4_000, policy: { targetIntervalFps: 1, maxIntervalCandidates: 4, maxTotalCandidates: 4, maxWidth: 640, imageFormat: 'jpeg', jpegQuality: 80 },
  effectiveIntervalFps: 1, candidates: [candidate(0, 500), candidate(1, 1_000), candidate(2, 1_500), candidate(3, 3_000)],
  temporarySourceVideoPath: '/tmp/source.mp4', temporaryDirectories: ['/tmp'], });
const selection = (input = set()) => ({ version: 1 as const, sourceVideoMediaId, sourceVideoContentHash, providerEligible: false as const,
  candidates: input.candidates.map((entry, index) => ({ candidateIndex: entry.candidateIndex, frameSha256: entry.frameSha256, technical: technical(index + 1) })),
  groups: [{ representativeIndex: 0, candidateIndexes: [0, 1] }, { representativeIndex: 2, candidateIndexes: [2] }, { representativeIndex: 3, candidateIndexes: [3] }], });
const transcript = (): VideoTranscript => ({ version: 1, model: 'whisper-1', sourceVideoMediaId, sourceVideoContentHash, language: 'en',
  segments: [{ segmentIndex: 0, startMs: 0, endMs: 1_000, text: 'First.' }, { segmentIndex: 1, startMs: 2_000, endMs: 3_500, text: 'Last.' }] });
const observation = (candidateIndex: number, sceneType: 'PERSON' | 'BRAND_CTA', topics: ('person' | 'brand' | 'call to action')[]) => ({
  version: 1 as const, model: 'test', providerEligible: false as const, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const,
  sourceVideoMediaId, sourceVideoContentHash, candidateIndex, timestampMs: set().candidates[candidateIndex].timestampMs,
  frameSha256: set().candidates[candidateIndex].frameSha256, observation: { sceneType, summary: 'Observable content.', composition: 'Simple.', visibleText: [], topics, uncertainties: [] }, });
const thumbnails = () => new Map([[0, JPEG_DATA_URL], [2, JPEG_DATA_URL], [3, JPEG_DATA_URL]]);

describe('video frame library assembly', () => {
  it('retains alternatives, joins speech by timestamp, and groups controlled visual semantics', () => {
    const library = assembleVideoFrameLibrary(set(), selection(), transcript(), [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand', 'call to action'])], thumbnails());
    expect(library.representativeFrames.map((frame) => [frame.candidateIndex, frame.candidateIndexes])).toEqual([[0, [0, 1]], [2, [2]], [3, [3]]]);
    expect(library.candidates).toHaveLength(4);
    expect(library.analysisModels).toEqual({ transcription: 'whisper-1', vision: ['test'] });
    expect(library.representativeFrames.map((frame) => frame.transcriptSegments.map((segment) => segment.text))).toEqual([['First.'], [], ['Last.']]);
    const [first, gap, last] = library.representativeFrames.map((frame) => frame.id);
    expect(library.semanticGroups).toEqual({ sceneTypes: [{ sceneType: 'PERSON', representativeFrameIds: [first] }, { sceneType: 'BRAND_CTA', representativeFrameIds: [gap, last] }], topics: [{ topic: 'person', representativeFrameIds: [first] }, { topic: 'brand', representativeFrameIds: [gap, last] }, { topic: 'call to action', representativeFrameIds: [last] }] });
    const json = JSON.stringify(library);
    expect(json).not.toMatch(/temporaryPath|temporaryDirectories|temporarySourceVideoPath|byteLength|approvedHumanSource|\/tmp/);
    expect(library.id).toMatch(/^video-library:[a-f0-9]{64}$/);
  });

  it('binds stable frame IDs to immutable timestamp and pixels rather than candidate ordinal', () => {
    const input = set();
    const observations = [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])];
    const unchanged = assembleVideoFrameLibrary(input, selection(input), transcript(), observations, thumbnails()).representativeFrames[0].id;
    const changedTime = set(); changedTime.candidates[0] = { ...changedTime.candidates[0], timestampMs: 600 };
    const changedPixels = set(); changedPixels.candidates[0] = { ...changedPixels.candidates[0], frameSha256: 'f'.repeat(64) };
    expect(assembleVideoFrameLibrary(changedTime, selection(changedTime), transcript(), [{ ...observations[0], timestampMs: 600 }, ...observations.slice(1)], thumbnails()).representativeFrames[0].id).not.toBe(unchanged);
    expect(assembleVideoFrameLibrary(changedPixels, selection(changedPixels), transcript(), [{ ...observations[0], frameSha256: 'f'.repeat(64) }, ...observations.slice(1)], thumbnails()).representativeFrames[0].id).not.toBe(unchanged);
    expect(assembleVideoFrameLibrary(set(), selection(), transcript(), observations, thumbnails()).representativeFrames[0].id).toBe(unchanged);
  });

  it.each([
    ['technical source', () => assembleVideoFrameLibrary(set(), { ...selection(), sourceVideoContentHash: 'other' }, transcript(), [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])], thumbnails())],
    ['transcript source', () => assembleVideoFrameLibrary(set(), selection(), { ...transcript(), sourceVideoMediaId: 'other' }, [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])], thumbnails())],
    ['technical frame', () => assembleVideoFrameLibrary(set(), { ...selection(), candidates: [{ ...selection().candidates[0], frameSha256: 'other' }, ...selection().candidates.slice(1)] }, transcript(), [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])], thumbnails())],
  ])('rejects %s provenance mismatches', (_name, assemble) => expect(assemble).toThrow());

  it.each([
    ['missing observation', [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand'])], thumbnails()],
    ['duplicate observation', [observation(0, 'PERSON', ['person']), observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])], thumbnails()],
    ['foreign observation', [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), { ...observation(3, 'BRAND_CTA', ['brand']), candidateIndex: 9 }, observation(3, 'BRAND_CTA', ['brand'])], thumbnails()],
    ['missing thumbnail', [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])], new Map([[0, JPEG_DATA_URL]])],
    ['empty thumbnail', [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])], new Map([[0, 'data:image/jpeg;base64,'], [2, JPEG_DATA_URL], [3, JPEG_DATA_URL]])],
    ['truncated thumbnail', [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])], new Map([[0, JPEG_DATA_URL.slice(0, -4)], [2, JPEG_DATA_URL], [3, JPEG_DATA_URL]])],
    ['mislabeled thumbnail', [observation(0, 'PERSON', ['person']), observation(2, 'BRAND_CTA', ['brand']), observation(3, 'BRAND_CTA', ['brand'])], new Map([[0, JPEG_DATA_URL.replace('image/jpeg', 'image/png')], [2, JPEG_DATA_URL], [3, JPEG_DATA_URL]])],
  ])('rejects %s representative evidence', (_name, observations, frameThumbnails) =>
    expect(() => assembleVideoFrameLibrary(set(), selection(), transcript(), observations, frameThumbnails)).toThrow());
});
