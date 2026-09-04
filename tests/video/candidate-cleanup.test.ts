import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTemporaryVideoFrameCandidateOwnership } from '@/lib/video/candidate-cleanup';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const temporaryRoots: string[] = [];
let realRm: typeof rm;

const candidateOwnership = (
  temporaryDirectories: readonly string[],
  temporarySourceVideoPath = path.join(temporaryDirectories[0] || tmpdir(), 'source.mp4')
) =>
  ({ temporaryDirectories, temporarySourceVideoPath }) as TemporaryVideoFrameCandidateSet;

const makeRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'candidate-cleanup-test-'));
  temporaryRoots.push(root);
  return root;
};

const expectMissing = async (target: string) => {
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
};

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises'
  );
  realRm = actual.rm;
  vi.mocked(rm).mockImplementation(realRm);
});

afterEach(async () => {
  vi.mocked(rm).mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      realRm(root, { recursive: true, force: true })
    )
  );
});

describe('temporary video frame candidate ownership cleanup', () => {
  it('removes every owned directory and nested source or unused scene artifacts', async () => {
    const root = await makeRoot();
    const intervalDirectory = path.join(root, 'interval');
    const sceneDirectory = path.join(root, 'scene');
    const sourceVideoPath = path.join(intervalDirectory, 'source.mp4');
    const unusedSceneFramePath = path.join(sceneDirectory, 'candidate-000000.jpg');

    await mkdir(intervalDirectory);
    await mkdir(sceneDirectory);
    await writeFile(sourceVideoPath, Buffer.from('video'));
    await writeFile(unusedSceneFramePath, Buffer.from('frame'));

    await cleanupTemporaryVideoFrameCandidateOwnership(
      candidateOwnership([intervalDirectory, sceneDirectory], sourceVideoPath)
    );

    await expectMissing(intervalDirectory);
    await expectMissing(sceneDirectory);
    await expectMissing(sourceVideoPath);
    await expectMissing(unusedSceneFramePath);
  });

  it('deduplicates ownership and tolerates repeated cleanup and missing directories', async () => {
    const root = await makeRoot();
    const ownedDirectory = path.join(root, 'owned');
    const missingDirectory = path.join(root, 'already-missing');
    await mkdir(ownedDirectory);

    const ownership = candidateOwnership([
      ownedDirectory,
      ownedDirectory,
      missingDirectory,
    ]);
    const mockedRm = vi.mocked(rm);
    mockedRm.mockClear();

    await cleanupTemporaryVideoFrameCandidateOwnership(ownership);
    expect(mockedRm).toHaveBeenCalledTimes(2);
    await expectMissing(ownedDirectory);

    await expect(cleanupTemporaryVideoFrameCandidateOwnership(ownership)).resolves.toBeUndefined();
    expect(mockedRm).toHaveBeenCalledTimes(4);
  });

  it('attempts remaining ownership and reports aggregate failure after a deletion fails', async () => {
    const root = await makeRoot();
    const failingDirectory = path.join(root, 'failing');
    const successfulDirectory = path.join(root, 'successful');
    await mkdir(failingDirectory);
    await mkdir(successfulDirectory);

    const mockedRm = vi.mocked(rm);
    mockedRm.mockImplementation(async (target, options) => {
      if (target === failingDirectory) {
        throw new Error('simulated cleanup failure');
      }
      return realRm(target, options);
    });

    let thrown: unknown;
    try {
      await cleanupTemporaryVideoFrameCandidateOwnership(
        candidateOwnership([failingDirectory, successfulDirectory])
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toHaveLength(1);
    expect((aggregate.errors[0] as Error).message).toContain(failingDirectory);
    expect(mockedRm).toHaveBeenCalledWith(successfulDirectory, {
      recursive: true,
      force: true,
    });
    await expectMissing(successfulDirectory);
    await expect(stat(failingDirectory)).resolves.toBeDefined();
  });
});
