import { emitProviderReuse } from '@/lib/ai/provider-telemetry';
import { analyzeReferenceCreative } from '@/lib/ai/openai';
import { validAnalysis } from '@/lib/creatives/planning-source-parser';
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
import { REUSABLE_ANGLE_SCHEMA_VERSION, parseReusableReferenceAngle, type ReusableReferenceAngle } from '@/lib/references/planning';
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

export interface ReusableAngleCache {
  readAngle(contentHash: string, analyzerModel: string): Promise<ReusableReferenceAngle | null>;
  writeAngle(value: ReusableReferenceAngle): Promise<void>;
}

export const CONTEXTUAL_ANGLE_SCHEMA_VERSION = 1;
export interface ContextualAngleCache {
  readContextualAngle(hash: string, contextHash: string, model: string): Promise<string | null>;
  writeContextualAngle(hash: string, contextHash: string, model: string, hook: string): Promise<void>;
}
const contextualFileName = (hash: string, contextHash: string, model: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{64}$/.test(contextHash) || !model.trim() || model.length > 200) throw new Error('Invalid contextual cache identity.');
  return `contextual-v${CONTEXTUAL_ANGLE_SCHEMA_VERSION}-${contextHash}-${createHash('sha256').update(model).digest('hex')}-${hash}.json`;
};
const validHook = (hook: unknown): hook is string => typeof hook === 'string' && hook.length <= 2000;

// Separate objects in the same backend avoid read/modify/write loss of blueprint or future fields.
const angleFileName = (hash: string, model: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash) || !model.trim() || model.length > 200) throw new Error('Invalid angle cache identity.');
  return `angle-v${REUSABLE_ANGLE_SCHEMA_VERSION}-${createHash('sha256').update(model).digest('hex')}-${hash}.json`;
};
abstract class ReferenceCache implements LayoutBlueprintCache, ReusableAngleCache, ContextualAngleCache {
  protected abstract readPayload(fileName: string): Promise<string | null>;
  protected abstract writePayload(fileName: string, payload: string): Promise<void>;
  async readContextualAngle(hash: string, contextHash: string, model: string) {
    const raw = await this.readPayload(contextualFileName(hash, contextHash, model));
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      return value?.version === CONTEXTUAL_ANGLE_SCHEMA_VERSION && value.sourceSha256 === hash
        && value.contextSha256 === contextHash && value.analyzerModel === model && validHook(value.hook)
        ? value.hook : null;
    } catch { return null; }
  }
  async writeContextualAngle(hash: string, contextHash: string, model: string, hook: string) {
    if (!validHook(hook)) throw new Error('Invalid contextual hook.');
    await this.writePayload(contextualFileName(hash, contextHash, model), JSON.stringify({
      version: CONTEXTUAL_ANGLE_SCHEMA_VERSION, sourceSha256: hash, contextSha256: contextHash, analyzerModel: model, hook,
    }));
  }
  async read(hash: string, model: string) {
    const raw = await this.readPayload(cacheFileName(hash, model));
    return raw === null ? null : parseCachePayload(raw);
  }
  async write(hash: string, model: string, blueprint: LayoutBlueprint) {
    await this.writePayload(cacheFileName(hash, model), serializeCachePayload(blueprint));
  }
  async readAngle(hash: string, model: string) {
    const raw = await this.readPayload(angleFileName(hash, model));
    if (raw === null) return null;
    try {
      const value = parseReusableReferenceAngle(JSON.parse(raw));
      return value?.sourceSha256 === hash && value.analyzerModel === model ? value : null;
    } catch { return null; }
  }
  async writeAngle(input: ReusableReferenceAngle) {
    const value = parseReusableReferenceAngle(input);
    if (!value) throw new Error('Invalid reusable angle metadata.');
    await this.writePayload(angleFileName(value.sourceSha256, value.analyzerModel), JSON.stringify(value));
  }
}

class LocalLayoutBlueprintCache extends ReferenceCache {
  private readonly root = (() => {
    const configured = process.env.LAYOUT_BLUEPRINT_CACHE_DIR;
    return configured
      ? resolve(/* turbopackIgnore: true */ process.cwd(), configured)
      : resolve(process.cwd(), 'data', 'layout-blueprints');
  })();

  protected async readPayload(fileName: string) {
    try {
      return await readFile(resolve(this.root, fileName), 'utf-8');
    } catch {
      return null;
    }
  }

  protected async writePayload(fileName: string, payload: string) {
    await mkdir(this.root, { recursive: true });
    await writeFile(
      resolve(this.root, fileName),
      payload,
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

class R2LayoutBlueprintCache extends ReferenceCache {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor() {
    super();
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

  private key(fileName: string) {
    return `_metadata/layout-blueprints/${fileName}`;
  }

  protected async readPayload(fileName: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: this.key(fileName),
        })
      );
      if (!response.Body) return null;
      return response.Body.transformToString();
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  protected async writePayload(fileName: string, payload: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: this.key(fileName),
        Body: payload,
        ContentType: 'application/json',
      })
    );
  }
}

let cache: ReferenceCache | undefined;

export const getLayoutBlueprintCache = (): LayoutBlueprintCache & ReusableAngleCache & ContextualAngleCache => {
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
    emitProviderReuse('layout-analysis', analyzerModel);
    return { blueprint: cached, contentHash, analyzerModel, cacheHit: true };
  }

  const analyze = dependencies.analyze || analyzeLayoutReference;
  const blueprint = parseLayoutBlueprint(await analyze(source));
  await activeCache.write(contentHash, analyzerModel, blueprint);

  return { blueprint, contentHash, analyzerModel, cacheHit: false };
}

/** Only new pending work consults this cache; saved results remain authoritative. */
export async function getOrAnalyzeContextualLayoutAngle(
  source: StoredMediaFile, context: string, onProviderOperationStart: () => void,
): Promise<string> {
  validateStoredMediaImage(source);
  const hash = createHash('sha256').update(source.buffer).digest('hex');
  // Hash the exact string passed to the unchanged analyzer, including whitespace.
  const contextHash = createHash('sha256').update(context).digest('hex');
  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  const activeCache = getLayoutBlueprintCache();
  const cached = await activeCache.readContextualAngle(hash, contextHash, model);
  if (cached !== null) { emitProviderReuse('source-reference-analysis', model); return cached; }
  onProviderOperationStart();
  const analysis = await analyzeReferenceCreative(source, context);
  if (!validAnalysis(analysis)) throw new Error('Invalid contextual analysis.');
  const hook = analysis.hookOrAngle.slice(0, 2000);
  // Propagate write failure to the caller's explicit Retry gate; never replay here.
  await activeCache.writeContextualAngle(hash, contextHash, model, hook);
  return hook;
}
