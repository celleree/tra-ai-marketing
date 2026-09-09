import { assertDeploymentRuntimeConsistent } from '@/lib/runtime/deployment';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const R2_PREFIX = '_metadata/tra-video-intelligence/v1';
const R2_TIMEOUT_MS = 30_000;
const R2_ENV_NAMES = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'] as const;

export interface VideoIntelligenceStorage {
  read(key: string): Promise<{ bytes: Buffer; etag: string } | null>;
  write(key: string, bytes: Buffer, expectedEtag: string | null): Promise<boolean>;
}

interface R2Config { accountId: string; accessKeyId: string; secretAccessKey: string; bucketName: string; environment: 'preview' | 'production'; }

const localWriteQueues = new Map<string, Promise<void>>();

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export const isSafeVideoIntelligenceArtifactKey = (key: string) =>
  key.length > 0 &&
  !key.startsWith('/') &&
  !/^[a-z]:/i.test(key) &&
  !key.includes('\\') &&
  key.split('/').every((part) => part && part !== '.' && part !== '..');

const isMissingObjectError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    [candidate.name, candidate.Code, candidate.code].includes('NoSuchKey')
  );
};

const isPreconditionError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.$metadata?.httpStatusCode === 409 ||
    candidate.$metadata?.httpStatusCode === 412 ||
    [candidate.name, candidate.Code, candidate.code].some(
      (value) => value === 'ConditionalRequestConflict' || value === 'PreconditionFailed'
    )
  );
};

const getR2Config = (): R2Config => {
  const environment = process.env.VERCEL_ENV?.trim();
  if (environment !== 'preview' && environment !== 'production') {
    throw new Error('Production video-intelligence storage requires VERCEL_ENV to be preview or production.');
  }

  const missing = R2_ENV_NAMES.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Production video-intelligence storage is incomplete. Missing: ${missing.join(', ')}`);
  }

  return {
    accountId: process.env.R2_ACCOUNT_ID!.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
    bucketName: process.env.R2_BUCKET_NAME!.trim(),
    environment,
  };
};

const withLocalWriteLock = async <Result>(
  filePath: string,
  operation: () => Promise<Result>
) => {
  const previous = localWriteQueues.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  localWriteQueues.set(filePath, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localWriteQueues.get(filePath) === queued) {
      localWriteQueues.delete(filePath);
    }
  }
};

export class LocalVideoIntelligenceStorage implements VideoIntelligenceStorage {
  private readonly rootDir: string;
  constructor(rootDir = path.resolve(process.cwd(), '.runtime', 'video-intelligence-artifacts')) {
    this.rootDir = path.resolve(rootDir);
  }

  private pathForKey(key: string) {
    if (!isSafeVideoIntelligenceArtifactKey(key)) {
      throw new Error('Invalid video-intelligence artifact key.');
    }
    const resolved = path.resolve(this.rootDir, ...key.split('/'));
    if (resolved === this.rootDir || !resolved.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error('Invalid video-intelligence artifact key.');
    }
    return resolved;
  }

  async read(key: string) {
    const filePath = this.pathForKey(key);
    try {
      const bytes = await readFile(filePath);
      return { bytes, etag: sha256(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(key: string, bytes: Buffer, expectedEtag: string | null) {
    const filePath = this.pathForKey(key);
    return withLocalWriteLock(filePath, async () => {
      const current = await this.read(key);
      if (expectedEtag === null ? current !== null : current?.etag !== expectedEtag) {
        return false;
      }

      await mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
      try {
        await writeFile(temporaryPath, bytes);
        await rename(temporaryPath, filePath);
        return true;
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
  }
}

export class R2VideoIntelligenceStorage implements VideoIntelligenceStorage {
  private readonly client: S3Client;

  constructor(private readonly config: R2Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  private objectKey(key: string) {
    if (!isSafeVideoIntelligenceArtifactKey(key)) {
      throw new Error('Invalid video-intelligence artifact key.');
    }
    return `${R2_PREFIX}/${this.config.environment}/${key}`;
  }

  private sendGet(command: GetObjectCommand) {
    return this.client.send(command, { abortSignal: AbortSignal.timeout(R2_TIMEOUT_MS) });
  }

  private sendPut(command: PutObjectCommand) {
    return this.client.send(command, { abortSignal: AbortSignal.timeout(R2_TIMEOUT_MS) });
  }

  async read(key: string) {
    const objectKey = this.objectKey(key);
    try {
      const response = await this.sendGet(
        new GetObjectCommand({ Bucket: this.config.bucketName, Key: objectKey })
      );
      if (!response.Body) {
        throw new Error(`R2 returned an empty body for video-intelligence artifact ${key}.`);
      }
      if (!response.ETag) {
        throw new Error(`R2 returned no ETag for video-intelligence artifact ${key}.`);
      }
      return {
        bytes: Buffer.from(await response.Body.transformToByteArray()),
        etag: response.ETag,
      };
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async write(key: string, bytes: Buffer, expectedEtag: string | null) {
    try {
      await this.sendPut(
        new PutObjectCommand({
          Bucket: this.config.bucketName,
          Key: this.objectKey(key),
          Body: bytes,
          ContentType: 'application/octet-stream',
          ...(expectedEtag === null
            ? { IfNoneMatch: '*' }
            : { IfMatch: expectedEtag }),
        })
      );
      return true;
    } catch (error) {
      if (isPreconditionError(error)) return false;
      throw error;
    }
  }
}

export const getVideoIntelligenceStorage = (): VideoIntelligenceStorage => {
  assertDeploymentRuntimeConsistent();
  return process.env.NODE_ENV === 'production'
    ? new R2VideoIntelligenceStorage(getR2Config())
    : new LocalVideoIntelligenceStorage();
};
