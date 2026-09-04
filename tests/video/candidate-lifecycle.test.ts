import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';

const sourceBuffer = Buffer.from('trusted-tra-video');
const sourceContentHash = createHash('sha256').update(sourceBuffer).digest('hex');
const source = {
  role: 'TRA_VIDEO',
  media: {
    id: 'media-video-1',
    fileName: 'source.mp4',
  },
  stored: {
    buffer: sourceBuffer,
  },
} as unknown as HydratedTraVideoSource;

const candidateSet = (): TemporaryVideoFrameCandidateSet => ({
  sourceVideoMediaId: 'media-video-1',
  sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash: sourceContentHash,
  durationMs: 4_000,
  policy: DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
  effectiveIntervalFps: 3,
  candidates: [
    {
      candidateIndex: 0,
      timestampMs: 250,
      sourceRole: 'TRA_VIDEO',
      sourceVideoMediaId: 'media-video-1',
      sourceVideoFileName: 'source.mp4',
      sourceVideoContentHash: sourceContentHash,
      mimeType: 'image/jpeg',
      width: 640,
      height: 360,
      byteLength: 123,
      frameSha256: 'a'.repeat(64),
      extractionReasons: ['INTERVAL'],
      temporaryPath: '/tmp/interval-candidates/candidate-000000.jpg',
      lifecycle: 'TEMPORARY',
      providerEligible: false,
    },
  ],
  temporarySourceVideoPath: '/tmp/interval-candidates/source.mp4',
  temporaryDirectories: ['/tmp/interval-candidates', '/tmp/scene-candidates'],
});

type InvalidCandidateSetMutation = (
  candidateSet: TemporaryVideoFrameCandidateSet
) => void;

const invalidBoundaryCases: Array<[string, InvalidCandidateSetMutation]> = [
  [
    'candidate-set source provenance',
    (ownership) => {
      ownership.sourceVideoContentHash = 'b'.repeat(64);
    },
  ],
  [
    'candidate source provenance',
    (ownership) => {
      ownership.candidates[0].sourceVideoMediaId = 'different-media';
    },
  ],
  [
    'provider eligibility',
    (ownership) => {
      (ownership.candidates[0] as unknown as { providerEligible: boolean }).providerEligible = true;
    },
  ],
  [
    'temporary lifecycle',
    (ownership) => {
      (ownership.candidates[0] as unknown as { lifecycle: string }).lifecycle = 'APPROVED';
    },
  ],
  [
    'approved-frame fields',
    (ownership) => {
      Object.assign(ownership.candidates[0], {
        approvedHumanSource: true,
        cacheKey: 'persistent/cache/key',
      });
    },
  ],
  [
    'extraction provenance',
    (ownership) => {
      (ownership.candidates[0] as unknown as { extractionReasons: string[] }).extractionReasons = [];
    },
  ],
  [
    'candidate ordering',
    (ownership) => {
      ownership.candidates[0].candidateIndex = 3;
    },
  ],
  [
    'candidate timestamp',
    (ownership) => {
      ownership.candidates[0].timestampMs = ownership.durationMs;
    },
  ],
  [
    'candidate temporary ownership',
    (ownership) => {
      ownership.candidates[0].temporaryPath = '/tmp/not-owned/candidate-000000.jpg';
    },
  ],
  [
    'source-video temporary ownership',
    (ownership) => {
      ownership.temporarySourceVideoPath = '/tmp/not-owned/source.mp4';
    },
  ],
];

describe('temporary TRA video candidate consumer lifecycle', () => {
  it('keeps ownership available to the consumer, then cleans exactly once and returns its result', async () => {
    const ownership = candidateSet();
    const events: string[] = [];
    const preprocessCandidates = vi.fn(async () => {
      events.push('preprocess');
      return ownership;
    });
    const cleanupCandidateOwnership = vi.fn(async () => {
      events.push('cleanup');
    });
    const consumer = vi.fn(async (received: TemporaryVideoFrameCandidateSet) => {
      events.push('consumer');
      expect(cleanupCandidateOwnership).not.toHaveBeenCalled();
      expect(received).toBe(ownership);
      return 'consumer-result';
    });

    const result = await withTemporaryTraVideoFrameCandidates(
      source,
      consumer,
      { preprocessCandidates, cleanupCandidateOwnership }
    );

    expect(result).toBe('consumer-result');
    expect(events).toEqual(['preprocess', 'consumer', 'cleanup']);
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
    expect(cleanupCandidateOwnership).toHaveBeenCalledWith(ownership);
  });

  it('cleans the original ownership even when the consumer reassigns temporary directories', async () => {
    const ownership = candidateSet();
    const originalDirectories = [...ownership.temporaryDirectories];
    const preprocessCandidates = vi.fn(async () => ownership);
    let cleanedOwnership: TemporaryVideoFrameCandidateSet | undefined;
    const cleanupCandidateOwnership = vi.fn(
      async (received: TemporaryVideoFrameCandidateSet) => {
        cleanedOwnership = received;
      }
    );

    await withTemporaryTraVideoFrameCandidates(
      source,
      async (received) => {
        received.temporaryDirectories = ['/tmp/not-owned-by-preprocessing'];
      },
      { preprocessCandidates, cleanupCandidateOwnership }
    );

    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
    expect(cleanedOwnership?.temporaryDirectories).toEqual(originalDirectories);
  });

  it.each(invalidBoundaryCases)(
    'rejects invalid %s before consumption and cleans transferred ownership',
    async (_label, mutate) => {
      const ownership = candidateSet();
      mutate(ownership);
      const preprocessCandidates = vi.fn(async () => ownership);
      const cleanupCandidateOwnership = vi.fn(async () => undefined);
      const consumer = vi.fn(async () => 'unused');

      await expect(
        withTemporaryTraVideoFrameCandidates(
          source,
          consumer,
          { preprocessCandidates, cleanupCandidateOwnership }
        )
      ).rejects.toThrow('Temporary video candidate boundary rejected:');

      expect(consumer).not.toHaveBeenCalled();
      expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
    }
  );

  it('propagates cleanup failure when consumption succeeds', async () => {
    const ownership = candidateSet();
    const cleanupError = new Error('cleanup failed');
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => {
      throw cleanupError;
    });

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        async () => 'done',
        { preprocessCandidates, cleanupCandidateOwnership }
      )
    ).rejects.toBe(cleanupError);
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
  });

  it('cleans after a consumer error and preserves the consumer error', async () => {
    const ownership = candidateSet();
    const consumerError = new Error('consumer failed');
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => undefined);

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        async () => {
          throw consumerError;
        },
        { preprocessCandidates, cleanupCandidateOwnership }
      )
    ).rejects.toBe(consumerError);
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
    expect(cleanupCandidateOwnership).toHaveBeenCalledWith(ownership);
  });

  it('preserves a lifecycle error when cleanup also fails', async () => {
    const ownership = candidateSet();
    const consumerError = new Error('consumer failed');
    const cleanupError = new Error('cleanup failed');
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => {
      throw cleanupError;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        withTemporaryTraVideoFrameCandidates(
          source,
          async () => {
            throw consumerError;
          },
          { preprocessCandidates, cleanupCandidateOwnership }
        )
      ).rejects.toBe(consumerError);
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to clean temporary video candidate ownership after lifecycle error.',
        cleanupError
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not perform lifecycle cleanup when preprocessing fails before ownership transfers', async () => {
    const preprocessingError = new Error('preprocessing failed');
    const preprocessCandidates = vi.fn(async () => {
      throw preprocessingError;
    });
    const cleanupCandidateOwnership = vi.fn(async () => undefined);
    const consumer = vi.fn(async () => 'unused');

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        consumer,
        { preprocessCandidates, cleanupCandidateOwnership }
      )
    ).rejects.toBe(preprocessingError);
    expect(consumer).not.toHaveBeenCalled();
    expect(cleanupCandidateOwnership).not.toHaveBeenCalled();
  });
});
