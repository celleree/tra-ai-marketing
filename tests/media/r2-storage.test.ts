import {
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { R2MediaStorage } from '@/lib/media/r2-storage';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn(function MockS3Client() {
      return { send: sendMock };
    }),
  };
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FILE_NAME = `media_${'a'.repeat(32)}.png`;

const makeFile = (bytes: readonly number[], type: string): File => {
  const data = Uint8Array.from(bytes);
  return {
    name: 'creative.png',
    type,
    size: data.byteLength,
    arrayBuffer: async () => data.buffer.slice(0),
  } as unknown as File;
};

const makeStorage = () =>
  new R2MediaStorage({
    accountId: 'account-id',
    accessKeyId: 'access-key-id',
    secretAccessKey: 'secret-access-key',
    bucketName: 'bucket-name',
  });

beforeEach(() => {
  sendMock.mockReset();
  vi.stubEnv('CREATIVE_PUBLIC_BASE_URL', '');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('R2 media storage observable contract', () => {
  it('writes the configured bucket, canonical key, content type, and bytes', async () => {
    sendMock.mockResolvedValueOnce({});
    const asset = await makeStorage().saveImage(
      makeFile(PNG_SIGNATURE, 'image/png')
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: 'bucket-name',
      Key: asset.fileName,
      ContentType: 'image/png',
    });
    expect((command as PutObjectCommand).input.Body).toEqual(
      Buffer.from(PNG_SIGNATURE)
    );
    expect(asset).not.toHaveProperty('buffer');
  });

  it('converts a successful R2 response body to a Buffer', async () => {
    sendMock.mockResolvedValueOnce({
      Body: {
        transformToByteArray: vi
          .fn()
          .mockResolvedValue(Uint8Array.from(PNG_SIGNATURE)),
      },
    });

    await expect(makeStorage().readImage(FILE_NAME)).resolves.toEqual({
      fileName: FILE_NAME,
      buffer: Buffer.from(PNG_SIGNATURE),
      mimeType: 'image/png',
    });
  });

  it.each([
    { name: 'NoSuchKey' },
    { Code: 'NoSuchKey' },
    { code: 'NoSuchKey' },
  ])('returns null for a missing-object error %#', async (error) => {
    sendMock.mockRejectedValueOnce(error);

    await expect(makeStorage().readImage(FILE_NAME)).resolves.toBeNull();
  });

  it('throws when R2 returns no body', async () => {
    sendMock.mockResolvedValueOnce({});

    await expect(makeStorage().readImage(FILE_NAME)).rejects.toThrow(
      `R2 returned an empty body for media object ${FILE_NAME}.`
    );
  });

  it('rethrows unrelated SDK, network, or authentication failures', async () => {
    const failure = new Error('R2 authentication failed');
    sendMock.mockRejectedValueOnce(failure);

    await expect(makeStorage().readImage(FILE_NAME)).rejects.toBe(failure);
  });
});
