import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import type { TemporaryVideoFrameCandidate, TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { getApprovedSelectedTraVideoFrames } from '@/lib/video/selected-frames';
import { REAL_SCENE_CHANGE_MP4 } from '@/tests/fixtures/video-candidate-scene';

const MEDIA_ID = `media_${'a'.repeat(32)}`;
const source = {
  role: 'TRA_VIDEO',
  media: {
    id: MEDIA_ID,
    fileName: `${MEDIA_ID}.mp4`,
    mimeType: 'video/mp4',
    mediaType: 'VIDEO',
    size: REAL_SCENE_CHANGE_MP4.length,
    url: `/api/media/files/${MEDIA_ID}.mp4`,
  },
  stored: { fileName: `${MEDIA_ID}.mp4`, buffer: REAL_SCENE_CHANGE_MP4,
    mimeType: 'video/mp4', mediaType: 'VIDEO' },
} as HydratedCreativeSourceAsset as HydratedTraVideoSource;
const OFFSET_MEDIA_ID = `media_${'c'.repeat(32)}`;
const OFFSET_PTS_MP4 = await readFile(
  new URL('../fixtures/video-offset-pts.mp4', import.meta.url)
);
const offsetSource = {
  ...source,
  media: {
    ...source.media,
    id: OFFSET_MEDIA_ID,
    fileName: `${OFFSET_MEDIA_ID}.mp4`,
    size: OFFSET_PTS_MP4.length,
  },
  stored: {
    ...source.stored,
    fileName: `${OFFSET_MEDIA_ID}.mp4`,
    buffer: OFFSET_PTS_MP4,
  },
} as HydratedTraVideoSource;

const hash = createHash('sha256').update(REAL_SCENE_CHANGE_MP4).digest('hex');
let library: VideoFrameLibrary;
let chosen: TemporaryVideoFrameCandidate[];
let candidateJpegs: Buffer[];

const makeLibrary = (set: TemporaryVideoFrameCandidateSet, representatives: TemporaryVideoFrameCandidate[]) =>
  ({
    version: 1,
    id: 'video-library:test',
    providerEligible: false,
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
    sourceVideoMediaId: set.sourceVideoMediaId,
    sourceVideoContentHash: set.sourceVideoContentHash,
    durationMs: set.durationMs,
    analysisModels: { transcription: 'test', vision: ['test'] },
    transcript: { version: 1, model: 'test', language: 'en', segments: [] },
    candidates: set.candidates.map((candidate) => ({
      candidateIndex: candidate.candidateIndex,
      timestampMs: candidate.timestampMs,
      width: candidate.width,
      height: candidate.height,
      extractionReasons: candidate.extractionReasons, frameSha256: candidate.frameSha256, technical: {},
    })),
    representativeFrames: representatives.map((candidate, index) => ({
      id: `chosen-${index}`,
      candidateIndexes: [candidate.candidateIndex], candidateIndex: candidate.candidateIndex,
      timestampMs: candidate.timestampMs, frameSha256: candidate.frameSha256, qualityScore: 1,
      thumbnailDataUrl: 'data:image/jpeg;base64,test',
      evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', observation: {}, transcriptSegments: [],
    })),
    semanticGroups: { sceneTypes: [], topics: [] },
  }) as unknown as VideoFrameLibrary;

const meanPixelDifference = async (left: Buffer, right: Buffer) => {
  const [first, second] = await Promise.all([
    sharp(left).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(right).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  expect(first.info).toMatchObject({
    width: second.info.width,
    height: second.info.height,
    channels: second.info.channels,
  });
  let difference = 0;
  for (let index = 0; index < first.data.length; index += 1) {
    difference += Math.abs(first.data[index] - second.data[index]);
  }
  return difference / first.data.length;
};

beforeAll(async () => {
  await withTemporaryTraVideoFrameCandidates(source, async (set) => {
    const interval = set.candidates.find((candidate) =>
      candidate.timestampMs > 0 && candidate.extractionReasons.includes('INTERVAL'));
    const scene = set.candidates.find((candidate) =>
      candidate.extractionReasons.includes('SCENE_CHANGE')
      && !candidate.extractionReasons.includes('INTERVAL'));
    expect(interval).toBeDefined();
    expect(scene).toBeDefined();
    chosen = [interval!, scene!];
    candidateJpegs = await Promise.all(
      chosen.map((candidate) => readFile(candidate.temporaryPath))
    );
    library = makeLibrary(set, chosen);
  });
}, 30_000);

describe('selected TRA video frame approval', () => {
  it('selects interval frames by timestamp when video PTS starts after audio', async () => {
    let offsetLibrary: VideoFrameLibrary | undefined;
    let intervalJpeg: Buffer | undefined;
    let wrongIntervalJpeg: Buffer | undefined;
    await withTemporaryTraVideoFrameCandidates(offsetSource, async (set) => {
      const interval = set.candidates.find(
        (candidate) =>
          candidate.timestampMs === 1_000 &&
          candidate.extractionReasons.includes('INTERVAL')
      );
      const oldIndexMatch = set.candidates.find(
        (candidate) =>
          candidate.timestampMs === 2_000 &&
          candidate.extractionReasons.includes('INTERVAL')
      );
      expect(interval).toBeDefined();
      expect(oldIndexMatch).toBeDefined();
      offsetLibrary = makeLibrary(set, [interval!]);
      intervalJpeg = await readFile(interval!.temporaryPath);
      wrongIntervalJpeg = await readFile(oldIndexMatch!.temporaryPath);
    });

    const result = await getApprovedSelectedTraVideoFrames(
      offsetSource,
      offsetLibrary!,
      [offsetLibrary!.representativeFrames[0].id]
    );
    expect(result.frames[0].timestampMs).toBe(1_000);
    const selectedDifference = await meanPixelDifference(
      result.frames[0].buffer, intervalJpeg!
    );
    const oldIndexDifference = await meanPixelDifference(
      result.frames[0].buffer, wrongIntervalJpeg!
    );
    expect(selectedDifference).toBeLessThan(12);
    expect(selectedDifference).toBeLessThan(oldIndexDifference);
  }, 30_000);

  it('re-extracts chosen interval and scene representatives as approved PNGs', async () => {
    const selectedIds = [
      library.representativeFrames[1].id,
      library.representativeFrames[0].id,
    ];
    const result = await getApprovedSelectedTraVideoFrames(
      source,
      library,
      selectedIds
    );

    expect(result).toMatchObject({
      source,
      sourceVideoContentHash: hash,
      durationMs: library.durationMs,
      reused: false,
    });
    expect(result.frames.map((frame) => frame.timestampMs)).toEqual([
      chosen[1].timestampMs,
      chosen[0].timestampMs,
    ]);
    expect(result.selectionProvenance).toEqual(
      result.frames.map((frame, frameIndex) => ({
        frameIndex,
        libraryFrameId: selectedIds[frameIndex],
        candidateFrameSha256: chosen[1 - frameIndex].frameSha256,
        timestampMs: chosen[1 - frameIndex].timestampMs,
        approvedPngSha256: frame.frameSha256,
      }))
    );
    for (const [index, frame] of result.frames.entries()) {
      expect(frame).toMatchObject({
        frameIndex: index,
        mimeType: 'image/png',
        sourceRole: 'TRA_VIDEO',
        sourceVideoMediaId: MEDIA_ID,
        sourceVideoFileName: `${MEDIA_ID}.mp4`,
        sourceVideoContentHash: hash,
        approvedHumanSource: true,
        cacheKey: null,
        byteLength: frame.buffer.length,
      });
      expect(frame.frameSha256).toBe(
        createHash('sha256').update(frame.buffer).digest('hex')
      );
      expect(frame.buffer.equals(candidateJpegs[1 - index])).toBe(false);
      expect(
        await meanPixelDifference(frame.buffer, candidateJpegs[1 - index])
      ).toBeLessThan(3);
    }
  }, 30_000);

  it.each([
    ['source ID', { sourceVideoMediaId: `media_${'b'.repeat(32)}` }],
    ['source hash', { sourceVideoContentHash: 'b'.repeat(64) }],
  ])('rejects a mismatched %s', async (_name, replacement) => {
    await expect(
      getApprovedSelectedTraVideoFrames(
        source,
        { ...library, ...replacement },
        [library.representativeFrames[0].id]
      )
    ).rejects.toThrow('does not match the hydrated source');
  });

  it('rejects unknown, duplicate, and out-of-range selections', async () => {
    await expect(
      getApprovedSelectedTraVideoFrames(source, library, ['missing'])
    ).rejects.toThrow('Unknown TRA video representative frame ID');
    await expect(
      getApprovedSelectedTraVideoFrames(source, library, [
        library.representativeFrames[0].id,
        library.representativeFrames[0].id,
      ])
    ).rejects.toThrow('must be unique');
    await expect(
      getApprovedSelectedTraVideoFrames(source, library, [])
    ).rejects.toThrow('Select between 1 and 3');
    await expect(
      getApprovedSelectedTraVideoFrames(source, library, [
        'one',
        'two',
        'three',
        'four',
      ])
    ).rejects.toThrow('Select between 1 and 3');
  });

  it('rejects a representative timestamp outside the saved video', async () => {
    const invalid = {
      ...library,
      representativeFrames: library.representativeFrames.map((frame, index) =>
        index === 0 ? { ...frame, timestampMs: library.durationMs } : frame
      ),
    };
    await expect(
      getApprovedSelectedTraVideoFrames(source, invalid, [
        invalid.representativeFrames[0].id,
      ])
    ).rejects.toThrow('require reanalysis');
  });

  it('rejects saved candidate pixels that drift from fresh analysis', async () => {
    const replacementHash = '0'.repeat(64);
    const drifted = {
      ...library,
      candidates: library.candidates.map((candidate, index) =>
        index === chosen[0].candidateIndex
          ? { ...candidate, frameSha256: replacementHash }
          : candidate),
      representativeFrames: library.representativeFrames.map((frame, index) =>
        index === 0 ? { ...frame, frameSha256: replacementHash } : frame),
    };
    await expect(getApprovedSelectedTraVideoFrames(
      source, drifted, [drifted.representativeFrames[0].id]
    )).rejects.toThrow('drifted from fresh analysis');
  }, 30_000);
});
