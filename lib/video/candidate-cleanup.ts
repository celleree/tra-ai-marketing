import { rm } from 'node:fs/promises';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';

export const cleanupTemporaryVideoFrameCandidateOwnership = async (
  candidateSet: TemporaryVideoFrameCandidateSet
): Promise<void> => {
  const failures: Error[] = [];

  for (const directory of new Set(candidateSet.temporaryDirectories)) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(
        new Error(`Failed to clean temporary video candidate directory: ${directory}`, {
          cause: error,
        })
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Failed to clean one or more temporary video candidate directories.'
    );
  }
};
