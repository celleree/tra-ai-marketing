import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  HydratedTraVideoSource,
  TraVideoCandidateExtractor,
  TraVideoSceneCandidateMaterializer,
} from '@/lib/video/candidate-extractor';
import { preprocessTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-preprocessor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type {
  TemporaryVideoFrameCandidate,
  TemporaryVideoFrameCandidateSet,
} from '@/lib/video/candidate-types';
import type { SceneChangeDetector } from '@/lib/video/scene-change-detector';

const intervalDirectory = path.join(tmpdir(), 'tra-video-candidates-cleanup-regression');
const sceneDirectory = path.join(tmpdir(), 'tra-video-scene-candidates-cleanup-regression');

const frame = (
  extractionReason: 'INTERVAL' | 'SCENE_CHANGE',
  temporaryDirectory: string
): TemporaryVideoFrameCandidate => ({
  candidateIndex: 0,
  timestampMs: 1_000,
  sourceRole: 'TRA_VIDEO',
  sourceVideoMediaId: 'media-video-1',
  sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash: 'source-hash',
  mimeType: 'image/jpeg',
  width: 640,
  height: 360,
  byteLength: 1_024,
  frameSha256: extractionReason === 'INTERVAL' ? 'interval-frame' : 'scene-frame',
  extractionReasons: [extractionReason],
  temporaryPath: path.join(temporaryDirectory, 'candidate.jpg'),
  lifecycle: 'TEMPORARY',
  providerEligible: false,
});

describe('temporary candidate preprocessing cleanup regression', () => {
  it('retains combined ownership when targeted collision cleanup fails', async () => {
    const intervalFrame = frame('INTERVAL', intervalDirectory);
    const sceneFrame = frame('SCENE_CHANGE', sceneDirectory);
    const intervalCandidates: TemporaryVideoFrameCandidateSet = {
      sourceVideoMediaId: 'media-video-1',
      sourceVideoFileName: 'source.mp4',
      sourceVideoContentHash: 'source-hash',
      durationMs: 4_000,
      policy: {
        ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
        maxIntervalCandidates: 4,
        maxTotalCandidates: 4,
      },
      effectiveIntervalFps: 3,
      candidates: [intervalFrame],
      temporarySourceVideoPath: path.join(intervalDirectory, 'source.mp4'),
      temporaryDirectories: [intervalDirectory],
    };
    const extractor: TraVideoCandidateExtractor = {
      extractCandidates: vi.fn(async () => intervalCandidates),
    };
    const sceneChangeDetector: SceneChangeDetector = {
      detect: vi.fn(async () => [1_000]),
    };
    const sceneCandidateMaterializer: TraVideoSceneCandidateMaterializer = {
      materializeCandidates: vi.fn(async () => ({
        candidates: [sceneFrame],
        temporaryDirectory: sceneDirectory,
      })),
    };
    const targetedCleanupError = new Error('targeted cleanup failed');
    const cleanupCandidateOwnership = vi
      .fn()
      .mockRejectedValueOnce(targetedCleanupError)
      .mockResolvedValueOnce(undefined);

    await expect(
      preprocessTemporaryTraVideoFrameCandidates(
        {} as HydratedTraVideoSource,
        {
          extractor,
          sceneChangeDetector,
          sceneCandidateMaterializer,
          cleanupCandidateOwnership,
        }
      )
    ).rejects.toBe(targetedCleanupError);

    expect(cleanupCandidateOwnership).toHaveBeenCalledTimes(2);
    expect(cleanupCandidateOwnership).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ temporaryDirectories: [sceneDirectory] })
    );
    expect(cleanupCandidateOwnership).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        temporaryDirectories: [intervalDirectory, sceneDirectory],
      })
    );
  });
});
