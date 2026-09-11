import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProofRecord, ReviewProofRecord } from '@/lib/proof/types';

const { mkdirMock, readFileMock, sendMock, writeFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  sendMock: vi.fn(),
  writeFileMock: vi.fn(),
}));
vi.mock('fs/promises', () => ({ mkdir: mkdirMock, readFile: readFileMock, writeFile: writeFileMock }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return { ...actual, S3Client: vi.fn(function MockS3Client() { return { send: sendMock }; }) };
});

import { addProofRecords, listProofRecords, updateProofRecord } from '@/lib/proof/storage';

const review = (
  hex = 'a',
  updatedAt = '2026-09-10T12:00:00.000Z'
): ReviewProofRecord => ({
  id: `proof_${hex.repeat(32)}`,
  type: 'review',
  originalReviewText: '  Exact punctuation—unchanged.\nSecond line.  ',
  tags: [],
  status: 'ACTIVE',
  createdAt: '2026-09-10T12:00:00.000Z',
  updatedAt,
});
const index = (items: ProofRecord[]) => JSON.stringify({ version: 1, items });
const configureR2 = () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('R2_ACCOUNT_ID', 'account');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('R2_BUCKET_NAME', 'bucket');
};
const r2Response = (items: ProofRecord[], etag: string) => ({
  ETag: etag,
  Body: { transformToString: vi.fn().mockResolvedValue(index(items)) },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  readFileMock.mockRejectedValue({ code: 'ENOENT' });
});

describe('Proof Library storage', () => {
  it('persists exact review text without inventing optional metadata', async () => {
    const record = review();
    await expect(addProofRecords([record])).resolves.toEqual([record]);

    const saved = JSON.parse(writeFileMock.mock.calls[0][1] as string);
    expect(saved.items[0].originalReviewText).toBe(record.originalReviewText);
    expect(saved.items[0]).not.toHaveProperty('source');
    expect(saved.items[0]).not.toHaveProperty('rating');
  });

  it('fails closed on malformed persisted records', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ version: 1, items: [{ id: 'bad' }] }));
    await expect(listProofRecords()).rejects.toThrow('invalid record');
  });

  it('rejects duplicate IDs without writing', async () => {
    const record = review();
    readFileMock.mockResolvedValue(index([record]));
    await expect(addProofRecords([record])).rejects.toThrow('already exists');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('updates status only from the expected record version', async () => {
    const current = review();
    readFileMock.mockResolvedValue(index([current]));
    const inactive = { ...current, status: 'INACTIVE' as const, updatedAt: '2026-09-10T13:00:00.000Z' };

    await expect(updateProofRecord(inactive, current.updatedAt)).resolves.toEqual(inactive);
    await expect(updateProofRecord(inactive, '2026-09-10T11:00:00.000Z')).rejects.toThrow(
      'changed before this update'
    );
    await expect(updateProofRecord(current, current.updatedAt)).rejects.toThrow(
      'changed before this update'
    );
  });

  it('queues local reads behind an in-progress write', async () => {
    let releaseWrite!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let stored = index([]);
    readFileMock.mockImplementation(async () => stored);
    writeFileMock.mockImplementation(async (_path, raw) => {
      await blocked;
      stored = raw as string;
    });

    const saving = addProofRecords([review()]);
    await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalledOnce());
    const listing = listProofRecords();
    await Promise.resolve();
    expect(readFileMock).toHaveBeenCalledOnce();
    releaseWrite();

    await saving;
    await expect(listing).resolves.toEqual([review()]);
  });

  it('uses a conditional create for a missing R2 index', async () => {
    configureR2();
    sendMock.mockRejectedValueOnce({ name: 'NoSuchKey' }).mockResolvedValueOnce({});
    await addProofRecords([review()]);

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    const put = sendMock.mock.calls[1][0] as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: 'bucket',
      Key: '_metadata/proof-library.json',
      IfNoneMatch: '*',
    });
  });

  it('refetches and preserves concurrent R2 additions after a write conflict', async () => {
    configureR2();
    const concurrent = review('b');
    sendMock
      .mockResolvedValueOnce(r2Response([], 'etag-1'))
      .mockRejectedValueOnce({ name: 'PreconditionFailed' })
      .mockResolvedValueOnce(r2Response([concurrent], 'etag-2'))
      .mockResolvedValueOnce({});

    await addProofRecords([review()]);
    const retry = sendMock.mock.calls[3][0] as PutObjectCommand;
    expect(retry.input.IfMatch).toBe('etag-2');
    expect(JSON.parse(retry.input.Body as string).items.map((item: ProofRecord) => item.id)).toEqual([
      review().id,
      concurrent.id,
    ]);
  });
});
