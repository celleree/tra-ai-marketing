import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';

const TEMPORARY_VIDEO_CANDIDATE_DIRECTORY_PREFIXES = [
  'tra-video-candidates-',
  'tra-video-scene-candidates-',
] as const;

export const isSafeTemporaryVideoCandidateDirectory = (directory: string) => {
  const resolvedDirectory = path.resolve(directory);
  const resolvedTempRoot = path.resolve(tmpdir());
  if (path.dirname(resolvedDirectory) !== resolvedTempRoot) return false;

  const baseName = path.basename(resolvedDirectory);
  return TEMPORARY_VIDEO_CANDIDATE_DIRECTORY_PREFIXES.some(
    (prefix) => baseName.startsWith(prefix) && baseName.length > prefix.length
  );
};

export const cleanupTemporaryVideoFrameCandidateOwnership = async (
  candidateSet: TemporaryVideoFrameCandidateSet
): Promise<void> => {
  const failures: Error[] = [];

  for (const directory of new Set(candidateSet.temporaryDirectories)) {
    if (!isSafeTemporaryVideoCandidateDirectory(directory)) {
      failures.push(
        new Error(`Refusing to clean unsafe temporary video candidate directory: ${directory}`)
      );
      continue;
    }

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
