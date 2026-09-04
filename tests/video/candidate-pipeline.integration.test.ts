import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';
import { REAL_SCENE_CHANGE_MP4 } from '@/tests/fixtures/video-candidate-scene';

const MEDIA_ID = `media_${'e'.repeat(32)}`;

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
  stored: {
    fileName: `${MEDIA_ID}.mp4`,
    buffer: REAL_SCENE_CHANGE_MP4,
    mimeType: 'video/mp4',
    mediaType: 'VIDEO',
  },
} as HydratedCreativeSourceAsset as HydratedTraVideoSource;

const pathExists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

describe('temporary TRA video candidate pipeline integration', () => {
  it('runs real interval and scene extraction through consumption and cleanup', async () => {
    let ownedPaths: string[] = [];
    let ownedDirectories: string[] = [];

    const consumedCount = await withTemporaryTraVideoFrameCandidates(
      source,
      async (candidateSet: TemporaryVideoFrameCandidateSet) => {
        expect(candidateSet.candidates.length).toBeGreaterThan(6);
        expect(candidateSet.candidates.length).toBeLessThanOrEqual(
          DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY.maxTotalCandidates
        );
        expect(candidateSet.candidates.map((candidate) => candidate.candidateIndex)).toEqual(
          candidateSet.candidates.map((_, index) => index)
        );
        expect(
          candidateSet.candidates.every(
            (candidate, index) =>
              index === 0 ||
              candidate.timestampMs > candidateSet.candidates[index - 1].timestampMs
          )
        ).toBe(true);
        expect(
          candidateSet.candidates.some((candidate) =>
            candidate.extractionReasons.includes('INTERVAL')
          )
        ).toBe(true);
        expect(
          candidateSet.candidates.some((candidate) =>
            candidate.extractionReasons.includes('SCENE_CHANGE')
          )
        ).toBe(true);

        for (const candidate of candidateSet.candidates) {
          expect(candidate).toMatchObject({
            sourceRole: 'TRA_VIDEO',
            sourceVideoMediaId: MEDIA_ID,
            sourceVideoFileName: `${MEDIA_ID}.mp4`,
            mimeType: 'image/jpeg',
            lifecycle: 'TEMPORARY',
            providerEligible: false,
          });
          expect(candidate.timestampMs).toBeGreaterThanOrEqual(0);
          expect(candidate.timestampMs).toBeLessThan(candidateSet.durationMs);
          expect(candidate.width).toBeGreaterThan(0);
          expect(candidate.width).toBeLessThanOrEqual(
            DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY.maxWidth
          );
          expect(candidate.height).toBeGreaterThan(0);
          expect(candidate.byteLength).toBeGreaterThan(0);
          expect(candidate.frameSha256).toMatch(/^[a-f0-9]{64}$/);
          await expect(pathExists(candidate.temporaryPath)).resolves.toBe(true);
        }

        ownedPaths = [
          candidateSet.temporarySourceVideoPath,
          ...candidateSet.candidates.map((candidate) => candidate.temporaryPath),
        ];
        ownedDirectories = [...candidateSet.temporaryDirectories];

        for (const ownedPath of ownedPaths) {
          await expect(pathExists(ownedPath)).resolves.toBe(true);
        }
        for (const ownedDirectory of ownedDirectories) {
          await expect(pathExists(ownedDirectory)).resolves.toBe(true);
        }

        return candidateSet.candidates.length;
      }
    );

    expect(consumedCount).toBeGreaterThan(6);
    for (const ownedPath of ownedPaths) {
      await expect(pathExists(ownedPath)).resolves.toBe(false);
    }
    for (const ownedDirectory of ownedDirectories) {
      await expect(pathExists(ownedDirectory)).resolves.toBe(false);
    }
  });
});
