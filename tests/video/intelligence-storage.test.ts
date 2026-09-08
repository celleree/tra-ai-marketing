import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVideoIntelligenceStorage, isSafeVideoIntelligenceArtifactKey, LocalVideoIntelligenceStorage, R2VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn(function MockS3Client() { return { send: sendMock }; }),
  };
});

const R2_CONFIG = {
  accountId: 'account-id',
  accessKeyId: 'access-key-id',
  secretAccessKey: 'secret-access-key',
  bucketName: 'bucket-name',
  environment: 'preview' as const,
};
const R2_ENV = {
  R2_ACCOUNT_ID: 'account-id',
  R2_ACCESS_KEY_ID: 'access-key-id',
  R2_SECRET_ACCESS_KEY: 'secret-access-key',
  R2_BUCKET_NAME: 'bucket-name',
} as const;
const KEY = 'jobs/job-1/manifest.bin';
const etag = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => sendMock.mockReset());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('local video-intelligence artifact storage', () => {
  it('creates, reads after a new instance, CAS-updates, and rejects stale writers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tra-video-artifacts-'));
    try {
      const first = new LocalVideoIntelligenceStorage(root);
      const initial = Buffer.from('first');
      expect(await first.write(KEY, initial, null)).toBe(true);
      expect(await new LocalVideoIntelligenceStorage(root).read(KEY)).toEqual({ bytes: initial, etag: etag(initial) });
      expect(await first.write(KEY, Buffer.from('second'), etag(initial))).toBe(true);
      expect(await first.write(KEY, Buffer.from('stale'), etag(initial))).toBe(false);
      expect(await first.write(KEY, Buffer.from('duplicate'), null)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes create races across instances and leaves no temporary artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tra-video-artifacts-'));
    try {
      const [left, right] = await Promise.all([new LocalVideoIntelligenceStorage(root).write(KEY, Buffer.from('left'), null), new LocalVideoIntelligenceStorage(root).write(KEY, Buffer.from('right'), null)]);
      expect([left, right].filter(Boolean)).toHaveLength(1);
      const bytes = await readFile(path.join(root, ...KEY.split('/')));
      expect(['left', 'right']).toContain(bytes.toString());
      const files = await import('node:fs/promises').then(({ readdir }) =>
        readdir(path.join(root, 'jobs', 'job-1'))
      );
      expect(files.some((file) => file.includes('.tmp-'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['', '/absolute', 'C:/absolute', '../escape', 'folder/../escape', 'folder\\escape'])(
    'rejects an unsafe relative key: %s',
    async (key) => {
      expect(isSafeVideoIntelligenceArtifactKey(key)).toBe(false);
      await expect(new LocalVideoIntelligenceStorage('C:\\safe').read(key)).rejects.toThrow('Invalid video-intelligence artifact key.');
    }
  );
});

describe('video-intelligence storage provider selection', () => {
  it('uses local storage outside production regardless of R2 configuration', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VERCEL_ENV', 'development');
    for (const [name, value] of Object.entries(R2_ENV)) vi.stubEnv(name, value);
    expect(getVideoIntelligenceStorage()).toBeInstanceOf(LocalVideoIntelligenceStorage);
  });

  it.each(['VERCEL_ENV', ...Object.keys(R2_ENV)])(
    'fails closed in production when %s is missing or unsupported',
    (missingName) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VERCEL_ENV', missingName === 'VERCEL_ENV' ? 'development' : 'preview');
      for (const [name, value] of Object.entries(R2_ENV)) {
        vi.stubEnv(name, name === missingName ? '' : value);
      }
      expect(() => getVideoIntelligenceStorage()).toThrow();
    }
  );
});

describe('R2 video-intelligence artifact storage', () => {
  it('keeps the same artifact key separate in preview and production', async () => {
    sendMock.mockResolvedValue({});
    await new R2VideoIntelligenceStorage(R2_CONFIG).write(KEY, Buffer.from('preview'), null);
    await new R2VideoIntelligenceStorage({ ...R2_CONFIG, environment: 'production' }).write(KEY, Buffer.from('production'), null);
    const keys = sendMock.mock.calls.map(([command]) => command.input.Key);
    expect(keys).toEqual([
      '_metadata/tra-video-intelligence/v1/preview/jobs/job-1/manifest.bin',
      '_metadata/tra-video-intelligence/v1/production/jobs/job-1/manifest.bin',
    ]);
  });

  it('uses the private environment prefix, opaque ETags, and conditional headers', async () => {
    sendMock.mockResolvedValue({});
    const storage = new R2VideoIntelligenceStorage(R2_CONFIG);
    expect(await storage.write(KEY, Buffer.from('one'), null)).toBe(true);
    expect(await storage.write(KEY, Buffer.from('two'), '"opaque-etag"')).toBe(true);

    const create = sendMock.mock.calls[0][0] as PutObjectCommand, update = sendMock.mock.calls[1][0] as PutObjectCommand;
    expect(create.input).toMatchObject({
      Bucket: 'bucket-name',
      Key: '_metadata/tra-video-intelligence/v1/preview/jobs/job-1/manifest.bin',
      ContentType: 'application/octet-stream',
      IfNoneMatch: '*',
    });
    expect(update.input.IfMatch).toBe('"opaque-etag"');
  });

  it('reads bytes and the exact quoted R2 ETag, returns null for 404, and fails on malformed responses', async () => {
    const storage = new R2VideoIntelligenceStorage(R2_CONFIG);
    sendMock.mockResolvedValueOnce({ Body: { transformToByteArray: vi.fn().mockResolvedValue(Uint8Array.from([1, 2])) }, ETag: '"r2-opaque"' });
    await expect(storage.read(KEY)).resolves.toEqual({ bytes: Buffer.from([1, 2]), etag: '"r2-opaque"' });
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);

    sendMock.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    await expect(storage.read(KEY)).resolves.toBeNull();
    sendMock.mockResolvedValueOnce({ Body: {} });
    await expect(storage.read(KEY)).rejects.toThrow('no ETag');
    sendMock.mockResolvedValueOnce({ ETag: '"present"' });
    await expect(storage.read(KEY)).rejects.toThrow('empty body');
  });

  it.each([{ $metadata: { httpStatusCode: 409 } }, { $metadata: { httpStatusCode: 412 } }])(
    'returns false for R2 conditional conflict %#',
    async (error) => {
      sendMock.mockRejectedValueOnce(error);
      await expect(new R2VideoIntelligenceStorage(R2_CONFIG).write(KEY, Buffer.from('bytes'), null)).resolves.toBe(false);
    }
  );

  it('propagates unrelated R2 failures', async () => {
    const failure = new Error('R2 unavailable');
    sendMock.mockRejectedValueOnce(failure);
    await expect(new R2VideoIntelligenceStorage(R2_CONFIG).read(KEY)).rejects.toBe(failure);
  });
});
