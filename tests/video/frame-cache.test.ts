import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { R2VideoFrameCache, getVideoFrameCacheKey } from '@/lib/video/frame-cache';
import type { VideoFrameManifest } from '@/lib/video/types';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return { ...actual, S3Client: vi.fn(function MockS3Client() { return { send: sendMock }; }) };
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MEDIA_ID = `media_${'b'.repeat(32)}`;
const HASH = 'c'.repeat(64);
const KEY = getVideoFrameCacheKey(MEDIA_ID, HASH, 0);
const MANIFEST: VideoFrameManifest = {
  version: 1,
  sourceRole: 'TRA_VIDEO',
  sourceVideoMediaId: MEDIA_ID,
  sourceVideoFileName: `${MEDIA_ID}.mp4`,
  sourceVideoMimeType: 'video/mp4',
  sourceVideoContentHash: HASH,
  durationMs: 1_000,
  frames: [{ frameIndex: 0, timestampMs: 0, mimeType: 'image/png', cacheKey: KEY }],
};
const makeCache = () => new R2VideoFrameCache({ accountId: 'account-id', accessKeyId: 'access-key-id', secretAccessKey: 'secret-access-key', bucketName: 'bucket-name' });

beforeEach(() => sendMock.mockReset());

describe('R2 derived TRA video frame cache', () => {
  it('stores frames under deterministic source-media and content-hash keys', async () => {
    sendMock.mockResolvedValueOnce({});
    await makeCache().writeFrame(KEY, PNG);
    const command = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({ Bucket: 'bucket-name', Key: KEY, ContentType: 'image/png', Body: PNG });
  });

  it('stores source provenance in the cache manifest', async () => {
    sendMock.mockResolvedValueOnce({});
    await makeCache().writeManifest(MANIFEST);
    const command = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(command.input.Key).toBe(`derived/video-frames/${MEDIA_ID}/${HASH}/manifest.json`);
    expect(JSON.parse(Buffer.from(command.input.Body as Buffer).toString('utf8'))).toEqual(MANIFEST);
  });

  it('reads and validates cached manifest and PNG bytes', async () => {
    sendMock
      .mockResolvedValueOnce({ Body: { transformToByteArray: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(MANIFEST))) } })
      .mockResolvedValueOnce({ Body: { transformToByteArray: vi.fn().mockResolvedValue(PNG) } });
    const cache = makeCache();
    await expect(cache.readManifest(MEDIA_ID, HASH)).resolves.toEqual(MANIFEST);
    await expect(cache.readFrame(KEY)).resolves.toEqual(PNG);
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
  });
});
