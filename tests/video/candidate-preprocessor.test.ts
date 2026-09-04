import { describe, expect, it, vi } from 'vitest';
import {
  type HydratedTraVideoSource,
  type TraVideoCandidateExtractor,
  type TraVideoSceneCandidateMaterializer,
} from '@/lib/video/candidate-extractor';
import { preprocessTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-preprocessor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type {
  TemporaryVideoFrameCandidate,
  TemporaryVideoFrameCandidateSet,
} from '@/lib/video/candidate-types';
import type { SceneChangeDetector } from '@/lib/video/scene-change-detector';

const source = {} as HydratedTraVideoSource;
const intervalDirectory = '/tmp/interval-candidates';
const sceneDirectory = '/tmp/scene-candidates';

const candidate = (
  timestampMs: number,
  extractionReasons: TemporaryVideoFrameCandidate['extractionReasons'] = ['INTERVAL'],
  overrides: Partial<TemporaryVideoFrameCandidate> = {}
): TemporaryVideoFrameCandidate => ({
  candidateIndex: 99,
  timestampMs,
  sourceRole: 'TRA_VIDEO',
  sourceVideoMediaId: 'media-video-1',
  sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash: 'source-hash',
  mimeType: 'image/jpeg',
  width: 640,
  height: 360,
  byteLength: 1_024,
  frameSha256: `frame-${timestampMs}`,
  extractionReasons,
  temporaryPath: `${extractionReasons[0] === 'INTERVAL' ? intervalDirectory : sceneDirectory}/${timestampMs}.jpg`,
  lifecycle: 'TEMPORARY',
  providerEligible: false,
  ...overrides,
});

const intervalCandidateSet = (
  candidates: TemporaryVideoFrameCandidate[],
  maxTotalCandidates = 4
): TemporaryVideoFrameCandidateSet => ({
  sourceVideoMediaId: 'media-video-1',
  sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash: 'source-hash',
  durationMs: 4_000,
  policy: {
    ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
    maxIntervalCandidates: maxTotalCandidates,
    maxTotalCandidates,
  },
  effectiveIntervalFps: 3,
  candidates,
  temporarySourceVideoPath: `${intervalDirectory}/source.mp4`,
  temporaryDirectories: [intervalDirectory],
});

const dependenciesFor = ({
  intervalCandidates,
  timestamps = [],
  sceneCandidates = [],
  sceneTemporaryDirectory = sceneDirectory,
  detectorError,
  materializerError,
  cleanupError,
}: {
  intervalCandidates: TemporaryVideoFrameCandidateSet;
  timestamps?: number[];
  sceneCandidates?: TemporaryVideoFrameCandidate[];
  sceneTemporaryDirectory?: string | null;
  detectorError?: Error;
  materializerError?: Error;
  cleanupError?: Error;
}) => {
  const extractor: TraVideoCandidateExtractor = {
    extractCandidates: vi.fn(async () => intervalCandidates),
  };
  const sceneChangeDetector: SceneChangeDetector = {
    detect: vi.fn(async () => {
      if (detectorError) throw detectorError;
      return timestamps;
    }),
  };
  const sceneCandidateMaterializer: TraVideoSceneCandidateMaterializer = {
    materializeCandidates: vi.fn(async () => {
      if (materializerError) throw materializerError;
      return { candidates: sceneCandidates, temporaryDirectory: sceneTemporaryDirectory };
    }),
  };
  const cleanupCandidateOwnership = vi.fn(async () => {
    if (cleanupError) throw cleanupError;
  });
  return {
    extractor,
    sceneChangeDetector,
    sceneCandidateMaterializer,
    cleanupCandidateOwnership,
  };
};

describe('temporary TRA video candidate preprocessing', () => {
  it('combines interval and scene candidates within the actual remaining budget', async () => {
    const intervalCandidates = intervalCandidateSet([
      candidate(0), candidate(1_000), candidate(2_000),
    ]);
    const dependencies = dependenciesFor({
      intervalCandidates,
      timestamps: [3_000],
      sceneCandidates: [candidate(3_000, ['SCENE_CHANGE'])],
    });

    const result = await preprocessTemporaryTraVideoFrameCandidates(source, dependencies);

    expect(dependencies.sceneChangeDetector.detect).toHaveBeenCalledWith(
      `${intervalDirectory}/source.mp4`, 4_000, 1
    );
    expect(dependencies.sceneCandidateMaterializer.materializeCandidates).toHaveBeenCalledWith(
      source, [3_000], intervalCandidates.policy
    );
    expect(result.candidates.map((frame) => frame.timestampMs)).toEqual([0, 1_000, 2_000, 3_000]);
    expect(result.temporaryDirectories).toEqual([intervalDirectory, sceneDirectory]);
    expect(result.candidates.every(
      (frame) => frame.lifecycle === 'TEMPORARY' && frame.providerEligible === false
    )).toBe(true);
    expect(dependencies.cleanupCandidateOwnership).not.toHaveBeenCalled();
  });

  it('skips scene work when interval candidates consume the total budget', async () => {
    const dependencies = dependenciesFor({
      intervalCandidates: intervalCandidateSet([candidate(0), candidate(1_000)], 2),
    });

    const result = await preprocessTemporaryTraVideoFrameCandidates(source, dependencies);

    expect(dependencies.sceneChangeDetector.detect).not.toHaveBeenCalled();
    expect(dependencies.sceneCandidateMaterializer.materializeCandidates).not.toHaveBeenCalled();
    expect(result.candidates.map((frame) => frame.timestampMs)).toEqual([0, 1_000]);
    expect(result.temporaryDirectories).toEqual([intervalDirectory]);
    expect(dependencies.cleanupCandidateOwnership).not.toHaveBeenCalled();
  });

  it('returns the interval-only result when scene detection finds no timestamps', async () => {
    const dependencies = dependenciesFor({
      intervalCandidates: intervalCandidateSet([candidate(1_000)]),
    });

    const result = await preprocessTemporaryTraVideoFrameCandidates(source, dependencies);

    expect(dependencies.sceneChangeDetector.detect).toHaveBeenCalledOnce();
    expect(dependencies.sceneCandidateMaterializer.materializeCandidates).not.toHaveBeenCalled();
    expect(result.candidates.map((frame) => frame.timestampMs)).toEqual([1_000]);
    expect(result.temporaryDirectories).toEqual([intervalDirectory]);
    expect(dependencies.cleanupCandidateOwnership).not.toHaveBeenCalled();
  });

  it('retains interval bytes and cleans an unreferenced scene directory for an exact collision', async () => {
    const interval = candidate(1_000, ['INTERVAL'], {
      frameSha256: 'interval-frame', temporaryPath: `${intervalDirectory}/interval.jpg`,
    });
    const dependencies = dependenciesFor({
      intervalCandidates: intervalCandidateSet([interval]),
      timestamps: [1_000],
      sceneCandidates: [candidate(1_000, ['SCENE_CHANGE'], {
        frameSha256: 'scene-frame', temporaryPath: `${sceneDirectory}/scene.jpg`,
      })],
    });

    const result = await preprocessTemporaryTraVideoFrameCandidates(source, dependencies);

    expect(result.candidates).toEqual([{
      ...interval,
      candidateIndex: 0,
      extractionReasons: ['INTERVAL', 'SCENE_CHANGE'],
    }]);
    expect(result.temporaryDirectories).toEqual([intervalDirectory]);
    expect(dependencies.cleanupCandidateOwnership).toHaveBeenCalledOnce();
    expect(dependencies.cleanupCandidateOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ temporaryDirectories: [sceneDirectory] })
    );
  });

  it.each([
    ['scene detection', { detectorError: new Error('detector failed') }, 'detector failed'],
    ['scene materialization', { materializerError: new Error('materializer failed') }, 'materializer failed'],
  ])('cleans interval ownership and propagates %s errors', async (_, errors, message) => {
    const intervalCandidates = intervalCandidateSet([candidate(0)]);
    const dependencies = dependenciesFor({
      intervalCandidates,
      timestamps: [1_000],
      ...errors,
    });

    await expect(
      preprocessTemporaryTraVideoFrameCandidates(source, dependencies)
    ).rejects.toThrow(message);
    expect(dependencies.cleanupCandidateOwnership).toHaveBeenCalledOnce();
    expect(dependencies.cleanupCandidateOwnership).toHaveBeenCalledWith(intervalCandidates);
  });

  it('cleans interval and scene ownership when merging fails after scene materialization', async () => {
    const intervalCandidates = intervalCandidateSet([candidate(0)]);
    const dependencies = dependenciesFor({
      intervalCandidates,
      timestamps: [1_000],
      sceneCandidates: [candidate(1_000, ['SCENE_CHANGE'], {
        sourceVideoMediaId: 'other-media',
      })],
    });

    await expect(
      preprocessTemporaryTraVideoFrameCandidates(source, dependencies)
    ).rejects.toThrow('sourceVideoMediaId');
    expect(dependencies.cleanupCandidateOwnership).toHaveBeenCalledOnce();
    expect(dependencies.cleanupCandidateOwnership).toHaveBeenCalledWith(
      expect.objectContaining({
        temporaryDirectories: [intervalDirectory, sceneDirectory],
      })
    );
  });

  it('cleans known ownership when scene materialization omits its temporary directory', async () => {
    const intervalCandidates = intervalCandidateSet([candidate(0)]);
    const dependencies = dependenciesFor({
      intervalCandidates,
      timestamps: [1_000],
      sceneCandidates: [candidate(1_000, ['SCENE_CHANGE'])],
      sceneTemporaryDirectory: null,
    });

    await expect(
      preprocessTemporaryTraVideoFrameCandidates(source, dependencies)
    ).rejects.toThrow('did not return a temporary directory');
    expect(dependencies.cleanupCandidateOwnership).toHaveBeenCalledWith(intervalCandidates);
  });

  it('preserves the processing error when cleanup also fails', async () => {
    const detectorError = new Error('detector failed');
    const cleanupError = new Error('cleanup failed');
    const intervalCandidates = intervalCandidateSet([candidate(0)]);
    const dependencies = dependenciesFor({
      intervalCandidates,
      detectorError,
      cleanupError,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        preprocessTemporaryTraVideoFrameCandidates(source, dependencies)
      ).rejects.toBe(detectorError);
      expect(dependencies.cleanupCandidateOwnership).toHaveBeenCalledWith(intervalCandidates);
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to clean temporary video candidate ownership after preprocessing error.',
        cleanupError
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
