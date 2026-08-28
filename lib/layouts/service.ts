import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  analyzeLayoutReference,
  getLayoutAnalysisModel,
} from '@/lib/ai/layout-analyzer';
import {
  LAYOUT_BLUEPRINT_SCHEMA_VERSION,
  parseLayoutBlueprint,
  type LayoutBlueprint,
} from '@/lib/layouts/blueprint';
import { validateStoredMediaImage } from '@/lib/media/storage';
import type { StoredMediaFile } from '@/lib/media/types';

export interface LayoutBlueprintCache {
  read(contentHash: string, analyzerModel: string): Promise<LayoutBlueprint | null>;
  write(
    contentHash: string,
    analyzerModel: string,
    blueprint: LayoutBlueprint
  ): Promise<void>;
}

export interface ResolvedLayoutBlueprint {
  blueprint: LayoutBlueprint;
  contentHash: string;
  analyzerModel: string;
  cacheHit: boolean;
}

type ResolveDependencies = {
  cache?: LayoutBlueprintCache;
  analyze?: (source: StoredMediaFile) => Promise<LayoutBlueprint>;
  analyzerModel?: string;
};

const cacheFileName = (contentHash: string, analyzerModel: string) => {
  const modelHash = createHash('sha256').update(analyzerModel).digest('hex').slice(0, 16);
  return `v${LAYOUT_BLUEPRINT_SCHEMA_VERSION}-${modelHash}-${contentHash}.json`;
};

const parseCachePayload = (raw: string): LayoutBlueprint | null => {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      blueprint?: unknown;
    };
    if (parsed.version !== LAYOUT_BLUEPRINT_SCHEMA_VERSION) return null;
    return parseLayoutBlueprint(parsed.blueprint);
  } catch {
    return null;
  }
};

const serializeCachePayload = (blueprint: LayoutBlueprint) =>
  JSON.stringify({
    version: LAYOUT_BLUEPRINT_SCHEMA_VERSION,
    blueprint,
  });

class LocalLayoutBlueprintCache implements LayoutBlueprintCache {
  private readonly root = (() => {
    const configured = process.env.LAYOUT_BLUEPRINT_CACHE_DIR;
    return configured
      ? resolve(/* turbopackIgnore: true */ process.cwd(), configured)
      : resolve(process.cwd(), 'data', 'layout-blueprints');
  })();

  async read(contentHash: string, analyzerModel: string) {
    try {
      return parseCachePayload(
        await readFile(resolve(this.root, cacheFileName(contentHash, analyzerModel)), 'utf-8')
      );
    } catch {
      return null;
    }
  }

  async write(
    contentHash: string,
    analyzerModel: string,
    blueprint: LayoutBlueprint
  ) {
    await mkdir(this.root, { recursive: true });
    await writeFile(
      resolve(this.root, cacheFileName(contentHash, analyzerModel)),
      serializeCachePayload(blueprint),
      'utf-8'
    );
  }
}

const isMissingObjectError = (error: unknown) =>
  error instanceof NoSuchKey ||
  (typeof error === 'object' &&
    error !== null &&
    (('name' in error && error.name === 'NoSuchKey') ||
      ('Code' in error && error.Code === 'NoSuchKey') ||
      ('code' in error && error.code === 'NoSuchKey')));

const getR2Config = () => {
  const required = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(
      `R2 layout-blueprint cache configuration is incomplete. Missing: ${missing.join(', ')}`
    );
  }

  return {
    accountId: process.env.R2_ACCOUNT_ID!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    bucketName: process.env.R2_BUCKET_NAME!,
  };
};

class R2LayoutBlueprintCache implements LayoutBlueprintCache {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor() {
    const config = getR2Config();
    this.bucketName = config.bucketName;
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  private key(contentHash: string, analyzerModel: string) {
    return `_metadata/layout-blueprints/${cacheFileName(contentHash, analyzerModel)}`;
  }

  async read(contentHash: string, analyzerModel: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: this.key(contentHash, analyzerModel),
        })
      );
      if (!response.Body) return null;
      return parseCachePayload(await response.Body.transformToString());
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async write(
    contentHash: string,
    analyzerModel: string,
    blueprint: LayoutBlueprint
  ) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: this.key(contentHash, analyzerModel),
        Body: serializeCachePayload(blueprint),
        ContentType: 'application/json',
      })
    );
  }
}

let cache: LayoutBlueprintCache | undefined;

export const getLayoutBlueprintCache = (): LayoutBlueprintCache => {
  if (cache) return cache;
  cache =
    process.env.NODE_ENV === 'production'
      ? new R2LayoutBlueprintCache()
      : new LocalLayoutBlueprintCache();
  return cache;
};

export async function getOrAnalyzeLayoutBlueprint(
  source: StoredMediaFile,
  dependencies: ResolveDependencies = {}
): Promise<ResolvedLayoutBlueprint> {
  validateStoredMediaImage(source);

  const contentHash = createHash('sha256').update(source.buffer).digest('hex');
  const analyzerModel = dependencies.analyzerModel || getLayoutAnalysisModel();
  const activeCache = dependencies.cache || getLayoutBlueprintCache();
  const cached = await activeCache.read(contentHash, analyzerModel);

  if (cached) {
    return { blueprint: cached, contentHash, analyzerModel, cacheHit: true };
  }

  const analyze = dependencies.analyze || analyzeLayoutReference;
  const blueprint = parseLayoutBlueprint(await analyze(source));
  await activeCache.write(contentHash, analyzerModel, blueprint);

  return { blueprint, contentHash, analyzerModel, cacheHit: false };
}
