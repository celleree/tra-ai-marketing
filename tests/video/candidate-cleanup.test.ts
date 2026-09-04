import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

const makeRoot = async (
  prefix: 'tra-video-candidates-' | 'tra-video-scene-candidates-' = 'tra-video-candidates-'
) => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
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
  it('removes every owned candidate directory and nested source or unused scene artifacts', async () => {
    const intervalDirectory = await makeRoot('tra-video-candidates-');
    const sceneDirectory = await makeRoot('tra-video-scene-candidates-');
    const sourceVideoPath = path.join(intervalDirectory, 'source.mp4');
    const unusedSceneFramePath = path.join(sceneDirectory, 'candidate-000000.jpg');

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

  it('deduplicates ownership and tolerates repeated cleanup and missing safe directories', async () => {
    const ownedDirectory = await makeRoot();
    const missingDirectory = path.join(
      tmpdir(),
      'tra-video-candidates-already-missing-test'
    );

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

  it('refuses unsafe directory claims while still cleaning safe ownership', async () => {
    const safeDirectory = await makeRoot();
    const unsafeDirectory = tmpdir();
    const mockedRm = vi.mocked(rm);
    mockedRm.mockClear();

    let thrown: unknown;
    try {
      await cleanupTemporaryVideoFrameCandidateOwnership(
        candidateOwnership([unsafeDirectory, safeDirectory])
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toHaveLength(1);
    expect((aggregate.errors[0] as Error).message).toContain(
      `Refusing to clean unsafe temporary video candidate directory: ${unsafeDirectory}`
    );
    expect(mockedRm).not.toHaveBeenCalledWith(unsafeDirectory, expect.anything());
    expect(mockedRm).toHaveBeenCalledWith(safeDirectory, {
      recursive: true,
      force: true,
    });
    await expectMissing(safeDirectory);
  });

  it('attempts remaining safe ownership and reports aggregate failure after a deletion fails', async () => {
    const failingDirectory = await makeRoot();
    const successfulDirectory = await makeRoot('tra-video-scene-candidates-');

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
