import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProofRecord, ReviewProofRecord, VideoPassageCandidate } from '@/lib/proof/types';

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

import { addProofRecords, getProofLibrarySnapshot, listProofRecords, mutateVideoPassageCandidate, updateProofRecord, upsertVideoPassageCandidate, videoPassageCandidateId } from '@/lib/proof/storage';

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
const candidate = (): VideoPassageCandidate => {
  const source = { locator: { version: 1 as const, sourceVideoMediaId: `media_${'b'.repeat(32)}`, sourceVideoContentHash: 'c'.repeat(64), analyzerFingerprintSha256: 'd'.repeat(64) }, library: { id: `video-library:${'e'.repeat(64)}`, version: 1 as const } };
  source.library.id = `video-library:${createHash('sha256').update(`${source.locator.sourceVideoMediaId}:${source.locator.sourceVideoContentHash}`).digest('hex')}`;
  const passage = { startSegmentIndex: 1, endSegmentIndex: 2, startMs: 100, endMs: 400, segments: [{ segmentIndex: 1, startMs: 100, endMs: 200, text: 'Exact source sentence.' }, { segmentIndex: 2, startMs: 300, endMs: 400, text: 'Second source sentence.' }] };
  return { version: 1, id: videoPassageCandidateId(source, passage), status: 'PENDING', source, passage, createdAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:00:00.000Z' };
};
const candidateIndex = (items: ProofRecord[], candidates: VideoPassageCandidate[]) => JSON.stringify({ version: 2, items, candidates: { version: 1, items: candidates } });
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
  it('reads legacy active records without manufacturing advertising approval', async () => {
    const legacy = review();
    readFileMock.mockResolvedValue(index([legacy]));
    const [loaded] = await listProofRecords();
    expect(loaded.status).toBe('ACTIVE');
    expect(loaded.advertisingUseApproved).toBeUndefined();
    expect(loaded.advertisingUseApproved === true).toBe(false);
  });

  it('preserves legacy reads, persists source-bound candidates, and derives lifecycle link health', async () => {
    let stored = index([review()]);
    readFileMock.mockImplementation(async () => stored);
    writeFileMock.mockImplementation(async (_path, raw) => { stored = raw as string; });
    await expect(getProofLibrarySnapshot()).resolves.toMatchObject({ candidates: [] });
    expect(writeFileMock).not.toHaveBeenCalled();
    const first = candidate();
    await expect(upsertVideoPassageCandidate(first)).resolves.toMatchObject({ created: true, candidate: first });
    expect(JSON.parse(stored)).toMatchObject({ version: 2, candidates: { version: 1, items: [first] } });
    await expect(upsertVideoPassageCandidate({ ...first, status: 'DISMISSED' })).resolves.toMatchObject({ created: false, candidate: first });
    const approved = { ...review(), advertisingUseApproved: true };
    stored = candidateIndex([approved], [first]);
    const linked = await mutateVideoPassageCandidate(first.id, 'link', approved.id);
    expect(linked).toMatchObject({ status: 'LINKED', link: { proofId: approved.id, proofType: 'review', proofUpdatedAt: approved.updatedAt } });
    expect(JSON.parse(stored).items[0]).toEqual(approved);
    stored = candidateIndex([{ ...approved, advertisingUseApproved: false }], [linked]);
    await expect(getProofLibrarySnapshot()).resolves.toMatchObject({ candidates: [{ id: first.id, linkHealth: 'UNAPPROVED' }] });
    await expect(mutateVideoPassageCandidate(first.id, 'dismiss')).resolves.toMatchObject({ status: 'DISMISSED' });
    await expect(mutateVideoPassageCandidate(first.id, 'reopen')).resolves.toMatchObject({ status: 'PENDING' });
    await expect(mutateVideoPassageCandidate(first.id, 'link', approved.id)).rejects.toThrow('not currently eligible');
  });

  it('persists exact review text without inventing optional metadata', async () => {
    const record = review();
    await expect(addProofRecords([record])).resolves.toEqual([record]);

    const saved = JSON.parse(writeFileMock.mock.calls[0][1] as string);
    expect(saved.items[0].originalReviewText).toBe(record.originalReviewText);
    expect(saved.items[0]).not.toHaveProperty('source');
    expect(saved.items[0]).not.toHaveProperty('rating');
  });

  it('persists explicit advertising approval and revocation values', async () => {
    const approved = { ...review(), advertisingUseApproved: true };
    await expect(addProofRecords([approved])).resolves.toEqual([approved]);
    let saved = JSON.parse(writeFileMock.mock.calls[0][1] as string);
    expect(saved.items[0].advertisingUseApproved).toBe(true);

    readFileMock.mockResolvedValue(index([approved]));
    const revoked = {
      ...approved,
      advertisingUseApproved: false,
      updatedAt: '2026-09-10T13:00:00.000Z',
    };
    await expect(updateProofRecord(revoked, approved.updatedAt)).resolves.toEqual(revoked);
    saved = JSON.parse(writeFileMock.mock.calls.at(-1)?.[1] as string);
    expect(saved.items[0].advertisingUseApproved).toBe(false);
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
