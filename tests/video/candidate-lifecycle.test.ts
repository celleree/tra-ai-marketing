import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';

const sourceBuffer = Buffer.from('trusted-tra-video');
const sourceContentHash = createHash('sha256').update(sourceBuffer).digest('hex');
const VALID_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYxLjMuMTAwAP/bAEMACAoKCwoLDQ0NDQ0NEA8QEBAQEBAQEBAQEBISEhUVFRISEhAQEhIUFBUVFxcXFRUVFRcXGRkZHh4cHCMjJCsrM//EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsAUX9//9k=',
  'base64'
);
const jpegSha256 = createHash('sha256').update(VALID_JPEG).digest('hex');
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

let temporaryDirectory = '';
let sourceVideoPath = '';
let candidatePath = '';

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'candidate-lifecycle-test-'));
  sourceVideoPath = path.join(temporaryDirectory, 'source.mp4');
  candidatePath = path.join(temporaryDirectory, 'candidate-000000.jpg');
  await Promise.all([
    writeFile(sourceVideoPath, sourceBuffer),
    writeFile(candidatePath, VALID_JPEG),
  ]);
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

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
      width: 2,
      height: 2,
      byteLength: VALID_JPEG.length,
      frameSha256: jpegSha256,
      extractionReasons: ['INTERVAL'],
      temporaryPath: candidatePath,
      lifecycle: 'TEMPORARY',
      providerEligible: false,
    },
  ],
  temporarySourceVideoPath: sourceVideoPath,
  temporaryDirectories: [temporaryDirectory],
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
    'candidate width policy',
    (ownership) => {
      ownership.candidates[0].width = ownership.policy.maxWidth + 1;
    },
  ],
  [
    'candidate byte-length metadata',
    (ownership) => {
      ownership.candidates[0].byteLength += 1;
    },
  ],
  [
    'candidate hash metadata',
    (ownership) => {
      ownership.candidates[0].frameSha256 = 'b'.repeat(64);
    },
  ],
  [
    'candidate dimension metadata',
    (ownership) => {
      ownership.candidates[0].width = 3;
    },
  ],
  [
    'candidate temporary ownership',
    (ownership) => {
      ownership.candidates[0].temporaryPath = path.join(
        tmpdir(),
        'not-owned-candidate-000000.jpg'
      );
    },
  ],
  [
    'source-video temporary ownership',
    (ownership) => {
      ownership.temporarySourceVideoPath = path.join(tmpdir(), 'not-owned-source.mp4');
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
        received.temporaryDirectories = [path.join(tmpdir(), 'not-owned-by-preprocessing')];
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

  it('rejects a missing owned source video before consumption', async () => {
    const ownership = candidateSet();
    await rm(sourceVideoPath, { force: true });
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => undefined);
    const consumer = vi.fn(async () => 'unused');

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        consumer,
        { preprocessCandidates, cleanupCandidateOwnership }
      )
    ).rejects.toThrow(
      'Temporary video candidate boundary rejected: temporary source video integrity does not match the hydrated TRA video.'
    );

    expect(consumer).not.toHaveBeenCalled();
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
  });

  it('rejects substituted source-video bytes before consumption', async () => {
    const ownership = candidateSet();
    await writeFile(sourceVideoPath, Buffer.from('different-video'));
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => undefined);
    const consumer = vi.fn(async () => 'unused');

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        consumer,
        { preprocessCandidates, cleanupCandidateOwnership }
      )
    ).rejects.toThrow(
      'Temporary video candidate boundary rejected: temporary source video integrity does not match the hydrated TRA video.'
    );

    expect(consumer).not.toHaveBeenCalled();
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
  });

  it('rejects a missing owned candidate file before consumption', async () => {
    const ownership = candidateSet();
    await rm(candidatePath, { force: true });
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => undefined);
    const consumer = vi.fn(async () => 'unused');

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        consumer,
        { preprocessCandidates, cleanupCandidateOwnership }
      )
    ).rejects.toThrow(
      'Temporary video candidate boundary rejected: candidate file integrity does not match its metadata.'
    );

    expect(consumer).not.toHaveBeenCalled();
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
  });

  it('rejects non-JPEG candidate bytes even when length and hash metadata match', async () => {
    const ownership = candidateSet();
    const invalidBytes = Buffer.from('not-a-jpeg');
    await writeFile(candidatePath, invalidBytes);
    ownership.candidates[0].byteLength = invalidBytes.length;
    ownership.candidates[0].frameSha256 = createHash('sha256')
      .update(invalidBytes)
      .digest('hex');
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => undefined);
    const consumer = vi.fn(async () => 'unused');

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        consumer,
        { preprocessCandidates, cleanupCandidateOwnership }
      )
    ).rejects.toThrow(
      'Temporary video candidate boundary rejected: candidate file integrity does not match its metadata.'
    );

    expect(consumer).not.toHaveBeenCalled();
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
  });

  it('rejects a producer policy that differs from the caller requested policy', async () => {
    const ownership = candidateSet();
    const requestedPolicy = {
      ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
      maxIntervalCandidates: 1,
      maxTotalCandidates: 1,
    };
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => undefined);
    const consumer = vi.fn(async () => 'unused');

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        consumer,
        { preprocessCandidates, cleanupCandidateOwnership },
        requestedPolicy
      )
    ).rejects.toThrow(
      'Temporary video candidate boundary rejected: candidate-set policy does not match the requested policy.'
    );

    expect(preprocessCandidates).toHaveBeenCalledWith(source, requestedPolicy);
    expect(consumer).not.toHaveBeenCalled();
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
  });

  it('rejects effective interval FPS that does not match the duration-limited interval budget', async () => {
    const ownership = candidateSet();
    const requestedPolicy = {
      ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
      maxIntervalCandidates: 1,
      maxTotalCandidates: 2,
    };
    ownership.policy = requestedPolicy;
    ownership.effectiveIntervalFps = 3;
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => undefined);
    const consumer = vi.fn(async () => 'unused');

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        consumer,
        { preprocessCandidates, cleanupCandidateOwnership },
        requestedPolicy
      )
    ).rejects.toThrow(
      'Temporary video candidate boundary rejected: effectiveIntervalFps does not match the requested policy and duration.'
    );

    expect(consumer).not.toHaveBeenCalled();
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
  });

  it('rejects more interval-derived candidates than the requested interval cap', async () => {
    const ownership = candidateSet();
    const requestedPolicy = {
      ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
      maxIntervalCandidates: 1,
      maxTotalCandidates: 2,
    };
    ownership.policy = requestedPolicy;
    ownership.effectiveIntervalFps = 0.25;
    const secondCandidatePath = path.join(
      temporaryDirectory,
      'candidate-000001.jpg'
    );
    await writeFile(secondCandidatePath, VALID_JPEG);
    ownership.candidates.push({
      ...ownership.candidates[0],
      candidateIndex: 1,
      timestampMs: 500,
      temporaryPath: secondCandidatePath,
    });
    const preprocessCandidates = vi.fn(async () => ownership);
    const cleanupCandidateOwnership = vi.fn(async () => undefined);
    const consumer = vi.fn(async () => 'unused');

    await expect(
      withTemporaryTraVideoFrameCandidates(
        source,
        consumer,
        { preprocessCandidates, cleanupCandidateOwnership },
        requestedPolicy
      )
    ).rejects.toThrow(
      'Temporary video candidate boundary rejected: interval candidate count is outside the requested bounded policy.'
    );

    expect(consumer).not.toHaveBeenCalled();
    expect(cleanupCandidateOwnership).toHaveBeenCalledOnce();
  });

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
