import { describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';

const source = {} as HydratedTraVideoSource;

const candidateSet = (): TemporaryVideoFrameCandidateSet => ({
  sourceVideoMediaId: 'media-video-1',
  sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash: 'source-hash',
  durationMs: 4_000,
  policy: DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
  effectiveIntervalFps: 3,
  candidates: [],
  temporarySourceVideoPath: '/tmp/interval-candidates/source.mp4',
  temporaryDirectories: ['/tmp/interval-candidates', '/tmp/scene-candidates'],
});

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

  it('preserves a consumer error when cleanup also fails', async () => {
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
        'Failed to clean temporary video candidate ownership after consumer error.',
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
