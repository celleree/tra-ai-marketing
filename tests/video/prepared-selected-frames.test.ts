import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { isStructurallyValidPng } from '@/lib/video/frame-cache';
import {
  createVideoIntelligenceAnalyzerFingerprint,
  type VideoIntelligencePreparationManifest,
} from '@/lib/video/intelligence-preparation';

const helpers = vi.hoisted(() => ({
  extract: vi.fn(),
  actualExtract: undefined as unknown as typeof import('@/lib/video/selected-frames').extractPng,
}));
vi.mock('@/lib/video/selected-frames', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/video/selected-frames')>();
  helpers.actualExtract = actual.extractPng;
  helpers.extract.mockImplementation(actual.extractPng);
  return { ...actual, extractPng: (...args: Parameters<typeof actual.extractPng>) =>
    helpers.extract(...args) };
});

import { getApprovedPreparedSelectedTraVideoFrames } from '@/lib/video/prepared-selected-frames';
import { getApprovedSelectedTraVideoFrames } from '@/lib/video/selected-frames';
import { REAL_SCENE_CHANGE_MP4 } from '@/tests/fixtures/video-candidate-scene';

const source = (buffer: Buffer, marker: string): HydratedTraVideoSource => {
  const id = `media_${marker.repeat(32)}`;
  return {
    role: 'TRA_VIDEO',
    media: { id, fileName: `${id}.mp4`, mimeType: 'video/mp4', mediaType: 'VIDEO',
      size: buffer.length, url: `/api/media/files/${id}.mp4` },
    stored: { fileName: `${id}.mp4`, buffer, mimeType: 'video/mp4', mediaType: 'VIDEO' },
  };
};
const sceneSource = source(REAL_SCENE_CHANGE_MP4, 'a');
const offsetSource = source(await readFile(
  new URL('../fixtures/video-offset-pts.mp4', import.meta.url)
), 'b');
const technical = {
  version: 1 as const, analysisWidth: 2, analysisHeight: 2,
  differenceHash: '0123456789abcdef', meanRgb: [1, 2, 3] as [number, number, number],
  meanLuminance: 2, luminanceDeviation: 1, laplacianVariance: 1,
  darkFraction: 0, lightFraction: 0, qualityScore: 1,
};

const preparedContext = async (
  input: HydratedTraVideoSource,
  choose: (set: TemporaryVideoFrameCandidateSet) => number[]
) => withTemporaryTraVideoFrameCandidates(input, async (set) => {
  const selectedIndexes = choose(set);
  const selected = selectedIndexes.map((index) => set.candidates[index]);
  const jpegs = await Promise.all(selected.map((candidate) => readFile(candidate.temporaryPath)));
  const groups = selectedIndexes.map((representativeIndex, index) => ({
    representativeIndex,
    candidateIndexes: index
      ? [representativeIndex]
      : set.candidates.map(({ candidateIndex }) => candidateIndex)
        .filter((candidateIndex) => !selectedIndexes.slice(1).includes(candidateIndex)),
  }));
  const bundleIndexes = [...selectedIndexes].sort((a, b) => a - b);
  let offset = 0;
  const entries = bundleIndexes.map((candidateIndex) => {
    const byteLength = set.candidates[candidateIndex].byteLength;
    const entry = { candidateIndex, offset, byteLength };
    offset += byteLength;
    return entry;
  });
  const fingerprint = createVideoIntelligenceAnalyzerFingerprint(set.policy, 'vision-model');
  const manifest: VideoIntelligencePreparationManifest = {
    version: 1, artifactType: 'VIDEO_INTELLIGENCE_PREPARATION', providerEligible: false,
    sourceVideoMediaId: set.sourceVideoMediaId, sourceVideoFileName: set.sourceVideoFileName,
    sourceVideoContentHash: set.sourceVideoContentHash,
    sourceVideoByteLength: input.stored.buffer.length, durationMs: set.durationMs,
    effectiveIntervalFps: set.effectiveIntervalFps, analyzerFingerprint: fingerprint,
    candidates: set.candidates.map((candidate) => ({
      candidateIndex: candidate.candidateIndex, timestampMs: candidate.timestampMs,
      sourceRole: candidate.sourceRole, sourceVideoMediaId: candidate.sourceVideoMediaId,
      sourceVideoFileName: candidate.sourceVideoFileName,
      sourceVideoContentHash: candidate.sourceVideoContentHash, mimeType: candidate.mimeType,
      width: candidate.width, height: candidate.height, byteLength: candidate.byteLength,
      frameSha256: candidate.frameSha256, extractionReasons: candidate.extractionReasons,
      providerEligible: false, technical,
    })),
    groups,
    representativeBundle: { key: 'prepared-test.bundle', sha256: 'c'.repeat(64),
      byteLength: offset, entries },
  };
  const library = {
    version: 1, id: 'video-library:test', providerEligible: false,
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
    sourceVideoMediaId: set.sourceVideoMediaId,
    sourceVideoContentHash: set.sourceVideoContentHash, durationMs: set.durationMs,
    analysisModels: { transcription: fingerprint.transcriptionModel, vision: [fingerprint.visionModel] },
    transcript: { version: 1, model: fingerprint.transcriptionModel, language: 'en', segments: [] },
    candidates: manifest.candidates,
    representativeFrames: selected.map((candidate, index) => ({
      id: `chosen-${index}`, candidateIndexes: groups[index].candidateIndexes,
      candidateIndex: candidate.candidateIndex, timestampMs: candidate.timestampMs,
      frameSha256: candidate.frameSha256, qualityScore: 1,
      thumbnailDataUrl: 'data:image/jpeg;base64,AA==',
      evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', observation: {}, transcriptSegments: [],
    })), semanticGroups: { sceneTypes: [], topics: [] },
  } as unknown as VideoFrameLibrary;
  return { manifest, library, jpegs };
});

let scene: Awaited<ReturnType<typeof preparedContext>>;
let offset: Awaited<ReturnType<typeof preparedContext>>;

beforeAll(async () => {
  scene = await preparedContext(sceneSource, (set) => [
    set.candidates.find((candidate) => candidate.timestampMs > 0
      && candidate.extractionReasons.includes('INTERVAL'))!.candidateIndex,
    set.candidates.find((candidate) => candidate.extractionReasons.includes('SCENE_CHANGE')
      && !candidate.extractionReasons.includes('INTERVAL'))!.candidateIndex,
  ]);
  offset = await preparedContext(offsetSource, (set) => [
    set.candidates.find((candidate) => candidate.timestampMs === 1_000
      && candidate.extractionReasons.includes('INTERVAL'))!.candidateIndex,
  ]);
}, 30_000);

beforeEach(() => {
  helpers.extract.mockReset();
  helpers.extract.mockImplementation(helpers.actualExtract);
});

const meanPixelDifference = async (left: Buffer, right: Buffer) => {
  const [a, b] = await Promise.all([
    sharp(left).removeAlpha().raw().toBuffer(), sharp(right).removeAlpha().raw().toBuffer(),
  ]);
  return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
};

describe('prepared selected TRA video frames', () => {
  it('concurrently extracts ordered interval and scene PNGs equivalent to legacy output', async () => {
    const ids = [...scene.library.representativeFrames].reverse().map(({ id }) => id);
    const [prepared, legacy] = await Promise.all([
      getApprovedPreparedSelectedTraVideoFrames(sceneSource, scene.library, ids, scene.manifest),
      getApprovedSelectedTraVideoFrames(sceneSource, scene.library, ids),
    ]);
    expect(helpers.extract).toHaveBeenCalledTimes(2);
    expect(prepared.frames.map(({ timestampMs }) => timestampMs)).toEqual(
      [...scene.library.representativeFrames].reverse().map(({ timestampMs }) => timestampMs)
    );
    expect(prepared.selectionProvenance.map(({ libraryFrameId }) => libraryFrameId)).toEqual(ids);
    for (const [index, frame] of prepared.frames.entries()) {
      expect(isStructurallyValidPng(frame.buffer)).toBe(true);
      expect(frame.buffer.equals(scene.jpegs[1 - index])).toBe(false);
      expect(await meanPixelDifference(frame.buffer, legacy.frames[index].buffer)).toBeLessThan(0.01);
    }
  }, 30_000);

  it('retains timestamp selection for offset video PTS', async () => {
    const id = offset.library.representativeFrames[0].id;
    const result = await getApprovedPreparedSelectedTraVideoFrames(
      offsetSource, offset.library, [id], offset.manifest
    );
    expect(result.frames[0].timestampMs).toBe(1_000);
    expect(await meanPixelDifference(result.frames[0].buffer, offset.jpegs[0])).toBeLessThan(12);
  }, 30_000);

  it.each([
    ['source ID', (manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) => {
      manifest.sourceVideoMediaId = 'drifted'; return library;
    }],
    ['source hash', (manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) => {
      manifest.sourceVideoContentHash = 'd'.repeat(64); return library;
    }],
    ['source byte length', (manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) => {
      manifest.sourceVideoByteLength += 1; return library;
    }],
    ['duration', (_manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) =>
      ({ ...library, durationMs: library.durationMs + 1 })],
    ['analyzer model', (_manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) =>
      ({ ...library, analysisModels: { ...library.analysisModels, vision: ['drifted'] } })],
    ['policy fingerprint', (manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) => {
      manifest.analyzerFingerprint.sha256 = 'd'.repeat(64); return library;
    }],
    ['selected timestamp', (manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) => {
      const index = library.representativeFrames[0].candidateIndex;
      manifest.candidates[index].timestampMs += 0.1; return library;
    }],
    ['selected hash', (manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) => {
      const index = library.representativeFrames[0].candidateIndex;
      manifest.candidates[index].frameSha256 = 'd'.repeat(64); return library;
    }],
    ['selected reasons', (manifest: VideoIntelligencePreparationManifest, library: VideoFrameLibrary) => {
      const index = library.representativeFrames[0].candidateIndex;
      manifest.candidates[index].extractionReasons = ['INTERVAL', 'SCENE_CHANGE']; return library;
    }],
  ])('rejects %s drift before extraction', async (_name, mutate) => {
    const root = await mkdtemp(path.join(tmpdir(), 'prepared-selected-test-'));
    try {
      const manifest = structuredClone(offset.manifest);
      const library = mutate(manifest, offset.library);
      await expect(getApprovedPreparedSelectedTraVideoFrames(
        offsetSource, library, [library.representativeFrames[0].id], manifest, { temporaryRoot: root }
      )).rejects.toThrow();
      expect(helpers.extract).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('drains all started extractions before reporting failure and cleanup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prepared-selected-drain-'));
    let release!: () => void;
    helpers.extract
      .mockRejectedValueOnce(new Error('first extraction failed'))
      .mockImplementationOnce(() => new Promise<Buffer>((resolve) => {
        release = () => resolve(Buffer.from('finished'));
      }));
    try {
      const operation = getApprovedPreparedSelectedTraVideoFrames(
        sceneSource, scene.library,
        scene.library.representativeFrames.map(({ id }) => id), scene.manifest,
        { temporaryRoot: root }
      );
      await vi.waitFor(() => expect(helpers.extract).toHaveBeenCalledTimes(2));
      expect(await readdir(root)).toHaveLength(1);
      release();
      await expect(operation).rejects.toThrow('first extraction failed');
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('cleans its owned source directory after real extraction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prepared-selected-cleanup-'));
    try {
      await getApprovedPreparedSelectedTraVideoFrames(
        offsetSource, offset.library, [offset.library.representativeFrames[0].id],
        offset.manifest, { temporaryRoot: root }
      );
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
