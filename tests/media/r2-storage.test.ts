import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { R2MediaStorage } from '@/lib/media/r2-storage';
import { MediaValidationError } from '@/lib/media/storage';
import { REAL_ENCODED_MP4 } from '@/tests/fixtures/media';

const { getSignedUrlMock, sendMock } = vi.hoisted(() => ({
  getSignedUrlMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn(function MockS3Client() {
      return { send: sendMock };
    }),
  };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MP4_SIGNATURE = Array.from(REAL_ENCODED_MP4);
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
  getSignedUrlMock.mockReset();
  sendMock.mockReset();
  vi.stubEnv('CREATIVE_PUBLIC_BASE_URL', '');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('R2 media storage observable contract', () => {
  it('creates a short-lived GET URL after validating object metadata', async () => {
    const signedUrl =
      'https://bucket.account.r2.cloudflarestorage.com/media.png?X-Amz-Signature=test';
    sendMock.mockResolvedValueOnce({ ContentLength: PNG_SIGNATURE.length });
    getSignedUrlMock.mockResolvedValueOnce(signedUrl);

    await expect(makeStorage().getMediaDeliveryUrl(FILE_NAME)).resolves.toBe(
      signedUrl
    );

    const headCommand = sendMock.mock.calls[0][0] as HeadObjectCommand;
    expect(headCommand).toBeInstanceOf(HeadObjectCommand);
    expect(headCommand.input).toEqual({
      Bucket: 'bucket-name',
      Key: FILE_NAME,
    });
    const getCommand = getSignedUrlMock.mock.calls[0][1] as GetObjectCommand;
    expect(getCommand).toBeInstanceOf(GetObjectCommand);
    expect(getCommand.input).toEqual({
      Bucket: 'bucket-name',
      Key: FILE_NAME,
    });
    expect(getSignedUrlMock.mock.calls[0][2]).toEqual({ expiresIn: 60 });
  });

  it('does not access R2 or sign a URL for a noncanonical stored name', async () => {
    await expect(
      makeStorage().getMediaDeliveryUrl('../fixture.png')
    ).resolves.toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'NotFound' },
    { $metadata: { httpStatusCode: 404 } },
  ])('does not sign a URL when object metadata is missing %#', async (error) => {
    sendMock.mockRejectedValueOnce(error);

    await expect(
      makeStorage().getMediaDeliveryUrl(FILE_NAME)
    ).resolves.toBeNull();
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it('does not sign a URL when object metadata exceeds the configured limit', async () => {
    vi.stubEnv('MAX_UPLOAD_BYTES', String(PNG_SIGNATURE.length));
    sendMock.mockResolvedValueOnce({ ContentLength: PNG_SIGNATURE.length + 1 });

    await expect(
      makeStorage().getMediaDeliveryUrl(FILE_NAME)
    ).rejects.toBeInstanceOf(MediaValidationError);
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

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

  it('writes real MP4 video through the generic media path without treating it as an image', async () => {
    sendMock.mockResolvedValueOnce({});
    const asset = await makeStorage().saveMedia(
      makeFile(MP4_SIGNATURE, 'video/mp4')
    );

    const command = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: 'bucket-name',
      Key: asset.fileName,
      ContentType: 'video/mp4',
    });
    expect(command.input.Body).toEqual(Buffer.from(MP4_SIGNATURE));
    expect(asset.mediaType).toBe('VIDEO');
    expect(asset.fileName).toMatch(/\.mp4$/);
  });

  it('converts a successful R2 response body to a Buffer', async () => {
    const transformToByteArray = vi
      .fn()
      .mockResolvedValue(Uint8Array.from(PNG_SIGNATURE));
    sendMock.mockResolvedValueOnce({
      ContentLength: PNG_SIGNATURE.length,
      Body: {
        transformToByteArray,
      },
    });

    await expect(makeStorage().readImage(FILE_NAME)).resolves.toEqual({
      fileName: FILE_NAME,
      buffer: Buffer.from(PNG_SIGNATURE),
      mimeType: 'image/png',
    });
    expect(transformToByteArray).toHaveBeenCalledOnce();
  });

  it('allows a response at the configured image limit', async () => {
    vi.stubEnv('MAX_UPLOAD_BYTES', String(PNG_SIGNATURE.length));
    sendMock.mockResolvedValueOnce({
      ContentLength: PNG_SIGNATURE.length,
      Body: {
        transformToByteArray: vi
          .fn()
          .mockResolvedValue(Uint8Array.from(PNG_SIGNATURE)),
      },
    });

    await expect(makeStorage().readImage(FILE_NAME)).resolves.toMatchObject({
      buffer: Buffer.from(PNG_SIGNATURE),
    });
  });

  it('allows a video response at the configured video limit', async () => {
    const fileName = `media_${'b'.repeat(32)}.mp4`;
    vi.stubEnv('MAX_VIDEO_UPLOAD_BYTES', String(MP4_SIGNATURE.length));
    sendMock.mockResolvedValueOnce({
      ContentLength: MP4_SIGNATURE.length,
      Body: {
        transformToByteArray: vi
          .fn()
          .mockResolvedValue(Uint8Array.from(MP4_SIGNATURE)),
      },
    });

    await expect(makeStorage().readMedia(fileName)).resolves.toMatchObject({
      mimeType: 'video/mp4',
      mediaType: 'VIDEO',
    });
  });

  it.each([
    {
      name: 'image',
      fileName: FILE_NAME,
      envName: 'MAX_UPLOAD_BYTES',
      limit: PNG_SIGNATURE.length,
    },
    {
      name: 'video',
      fileName: `media_${'b'.repeat(32)}.mp4`,
      envName: 'MAX_VIDEO_UPLOAD_BYTES',
      limit: MP4_SIGNATURE.length,
    },
  ])('rejects an oversized $name response before buffering', async ({ fileName, envName, limit }) => {
    vi.stubEnv(envName, String(limit));
    const transformToByteArray = vi.fn();
    const destroy = vi.fn();
    sendMock.mockResolvedValueOnce({
      ContentLength: limit + 1,
      Body: { transformToByteArray, destroy },
    });

    await expect(makeStorage().readMedia(fileName)).rejects.toMatchObject({
      name: 'MediaValidationError',
      message: `The ${fileName.endsWith('.mp4') ? 'video' : 'image'} is larger than the upload limit.`,
    });
    expect(transformToByteArray).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([undefined, Number.NaN, -1, 1.5])(
    'fails closed for an invalid R2 content length of %p',
    async (ContentLength) => {
      const transformToByteArray = vi.fn();
      const cancel = vi.fn().mockResolvedValue(undefined);
      sendMock.mockResolvedValueOnce({
        ContentLength,
        Body: { transformToByteArray, cancel },
      });

      await expect(makeStorage().readMedia(FILE_NAME)).rejects.toMatchObject({
        name: 'MediaValidationError',
        message: `R2 returned an invalid content length for media object ${FILE_NAME}.`,
      });
      expect(transformToByteArray).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it('preserves the validation error when body cleanup fails', async () => {
    vi.stubEnv('MAX_UPLOAD_BYTES', String(PNG_SIGNATURE.length));
    const transformToByteArray = vi.fn();
    const destroy = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    sendMock.mockResolvedValueOnce({
      ContentLength: PNG_SIGNATURE.length + 1,
      Body: { transformToByteArray, destroy },
    });

    await expect(makeStorage().readMedia(FILE_NAME)).rejects.toMatchObject({
      name: 'MediaValidationError',
      message: 'The image is larger than the upload limit.',
    });
    expect(transformToByteArray).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
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
