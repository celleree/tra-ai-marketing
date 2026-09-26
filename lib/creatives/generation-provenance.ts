import {
  isCreativeSourceRole,
  type CreativeSourceRole,
} from '@/lib/media/types';
import {
  isCreativeImageModel,
  isCreativeImageOperationType,
  FALLBACK_CREATIVE_IMAGE_MODEL,
  PREFERRED_CREATIVE_IMAGE_MODEL,
  type CreativeImageRouting,
} from '@/lib/creatives/image-models';
import { parseSourceOverlayDecision, type SourceCrop, type SourceOverlayDecision } from '@/lib/video/source-overlay-contract';

const SAFE_MEDIA_ID = /^media_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type CreativeGenerationProvenance = {
  version: 1;
  imageGeneration: { prompt: string; model: string; routing?: CreativeImageRouting };
  requestedSources: Array<{
    role: CreativeSourceRole;
    mediaId: string;
    sha256: string;
  }>;
  attachedSource:
    | null
    | { type: 'TRA_REFERENCE_IMAGE'; mediaId: string; sha256: string }
    | {
        type: 'TRA_VIDEO_FRAMES';
        mediaId: string;
        sourceSha256: string;
        selectionMode: 'AUTOMATIC' | 'USER_SELECTED';
        frames: Array<{ timestampMs: number; approvedPngSha256: string;
          providerPngSha256?: string; sourceOverlay?: SourceOverlayDecision; crop?: SourceCrop | null }>;
      };
  analysisSources: Array<
    | {
        type: 'LAYOUT_REFERENCE';
        mediaId: string;
        sha256: string;
        layoutCache: {
          sourceSha256: string;
          analyzerModel: string;
          schemaVersion: 1;
        };
      }
    | { type: 'REFERENCE_LIBRARY'; mediaId: string }
  >;
  logoOverlaySource?: { mediaId: string; sha256: string };
  // A saved rendition used as an editing canvas is separate from approved human sources.
  revision?: {
    parentCreativeId: string;
    canvasMediaId: string;
    canvasSha256: string;
    instruction?: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const isHash = (value: unknown): value is string =>
  typeof value === 'string' && SHA256.test(value);

const isMediaId = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_MEDIA_ID.test(value);

const isNonBlankModel = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

// Informational shape validation only. Editing/generation must independently
// hydrate and validate original sources; this metadata never grants eligibility.
export const parseCreativeGenerationProvenance = (
  value: unknown
): CreativeGenerationProvenance | null => {
  if (!isRecord(value)) return null;

  const rootKeys = ['version', 'imageGeneration', 'requestedSources', 'attachedSource', 'analysisSources'];
  for (const key of ['logoOverlaySource', 'revision']) if (key in value) rootKeys.push(key);
  if (
    !hasExactKeys(value, rootKeys) ||
    value.version !== 1 ||
    !isRecord(value.imageGeneration) ||
    !hasExactKeys(value.imageGeneration, [
      'prompt',
      'model',
      ...('routing' in value.imageGeneration ? ['routing'] : []),
    ]) ||
    typeof value.imageGeneration.prompt !== 'string' ||
    value.imageGeneration.prompt.length === 0 ||
    !isNonBlankModel(value.imageGeneration.model) ||
    !Array.isArray(value.requestedSources) ||
    !Array.isArray(value.analysisSources)
  ) {
    return null;
  }

  let routing: CreativeImageRouting | undefined;
  if ('routing' in value.imageGeneration) {
    const route = value.imageGeneration.routing;
    if (
      !isRecord(route) ||
      !hasExactKeys(route, [
        'operationType',
        'preferredModel',
        'actualModel',
        'fallbackUsed',
        'fallbackFromModel',
        'fallbackReason',
      ]) ||
      !isCreativeImageOperationType(route.operationType) ||
      !isCreativeImageModel(route.preferredModel) ||
      !isCreativeImageModel(route.actualModel) ||
      route.preferredModel !== PREFERRED_CREATIVE_IMAGE_MODEL ||
      typeof route.fallbackUsed !== 'boolean' ||
      route.actualModel !== value.imageGeneration.model ||
      (route.fallbackUsed
        ? route.fallbackFromModel !== route.preferredModel ||
          route.actualModel === route.preferredModel ||
          route.actualModel !== FALLBACK_CREATIVE_IMAGE_MODEL ||
          typeof route.fallbackReason !== 'string' ||
          !/^[a-z0-9_]{1,80}$/.test(route.fallbackReason)
        : route.fallbackFromModel !== null ||
          route.fallbackReason !== null ||
          route.actualModel !== route.preferredModel)
    ) {
      return null;
    }
    routing = route as CreativeImageRouting;
  }

  const requestedSources = value.requestedSources.map((source) => {
    if (!isRecord(source) || !hasExactKeys(source, ['role', 'mediaId', 'sha256'])) return null;
    if (
      typeof source.role !== 'string' ||
      !isCreativeSourceRole(source.role) ||
      !isMediaId(source.mediaId) ||
      !isHash(source.sha256)
    ) {
      return null;
    }
    return { role: source.role, mediaId: source.mediaId, sha256: source.sha256 };
  });
  if (requestedSources.some((source) => !source)) return null;

  const validRequestedSources = requestedSources as CreativeGenerationProvenance['requestedSources'];
  if (new Set(validRequestedSources.map((source) => source.mediaId)).size !== validRequestedSources.length) return null;

  const requestedSource = (role: CreativeSourceRole, mediaId: string, sha256: string) =>
    validRequestedSources.some(
      (source) => source.role === role && source.mediaId === mediaId && source.sha256 === sha256
    );

  let attachedSource: CreativeGenerationProvenance['attachedSource'];
  if (value.attachedSource === null) {
    attachedSource = null;
  } else if (isRecord(value.attachedSource) && value.attachedSource.type === 'TRA_REFERENCE_IMAGE') {
    if (
      !hasExactKeys(value.attachedSource, ['type', 'mediaId', 'sha256']) ||
      !isMediaId(value.attachedSource.mediaId) ||
      !isHash(value.attachedSource.sha256) ||
      !requestedSource('TRA_REFERENCE', value.attachedSource.mediaId, value.attachedSource.sha256)
    ) return null;
    attachedSource = value.attachedSource as CreativeGenerationProvenance['attachedSource'];
  } else if (isRecord(value.attachedSource) && value.attachedSource.type === 'TRA_VIDEO_FRAMES') {
    const source = value.attachedSource;
    if (
      !hasExactKeys(source, ['type', 'mediaId', 'sourceSha256', 'selectionMode', 'frames']) ||
      !isMediaId(source.mediaId) ||
      !isHash(source.sourceSha256) ||
      (source.selectionMode !== 'AUTOMATIC' && source.selectionMode !== 'USER_SELECTED') ||
      !Array.isArray(source.frames) ||
      source.frames.length < 1 ||
      source.frames.length > 3 ||
      !requestedSource('TRA_VIDEO', source.mediaId, source.sourceSha256)
    ) return null;
    const frames = source.frames.map((frame) => {
      if (!isRecord(frame) || !(hasExactKeys(frame, ['timestampMs', 'approvedPngSha256'])
        || hasExactKeys(frame, ['timestampMs', 'approvedPngSha256', 'providerPngSha256', 'sourceOverlay', 'crop']))) return null;
      if (typeof frame.timestampMs !== 'number' || !Number.isSafeInteger(frame.timestampMs) || frame.timestampMs < 0 || !isHash(frame.approvedPngSha256)) return null;
      if (!('providerPngSha256' in frame)) return { timestampMs: frame.timestampMs, approvedPngSha256: frame.approvedPngSha256 };
      const decision = parseSourceOverlayDecision(frame.sourceOverlay);
      const crop = frame.crop;
      if (!isHash(frame.providerPngSha256) || !decision || decision.status === 'UNSAFE'
        || (decision.status === 'CLEAN' && (crop !== null || frame.providerPngSha256 !== frame.approvedPngSha256))
        || (decision.status === 'EDGE_CROP' && (!isRecord(crop)
          || !hasExactKeys(crop, ['left', 'top', 'width', 'height'])
          || ![crop.left, crop.top, crop.width, crop.height].every(value => Number.isSafeInteger(value) && Number(value) >= 0)
          || Number(crop.width) < 2 || Number(crop.height) < 2))) return null;
      return { timestampMs: frame.timestampMs, approvedPngSha256: frame.approvedPngSha256,
        providerPngSha256: frame.providerPngSha256, sourceOverlay: decision, crop: crop as SourceCrop | null };
    });
    if (frames.some((frame) => !frame)) return null;
    const validFrames = frames as NonNullable<Extract<CreativeGenerationProvenance['attachedSource'], { type: 'TRA_VIDEO_FRAMES' }>>['frames'];
    if (new Set(validFrames.map((frame) => `${frame.timestampMs}:${frame.approvedPngSha256}`)).size !== validFrames.length) return null;
    attachedSource = { type: 'TRA_VIDEO_FRAMES', mediaId: source.mediaId, sourceSha256: source.sourceSha256, selectionMode: source.selectionMode, frames: validFrames };
  } else {
    return null;
  }

  const analysisSources = value.analysisSources.map((source) => {
    if (!isRecord(source)) return null;
    if (source.type === 'REFERENCE_LIBRARY') {
      return hasExactKeys(source, ['type', 'mediaId']) && isMediaId(source.mediaId)
        ? { type: 'REFERENCE_LIBRARY' as const, mediaId: source.mediaId }
        : null;
    }
    if (
      source.type !== 'LAYOUT_REFERENCE' ||
      !hasExactKeys(source, ['type', 'mediaId', 'sha256', 'layoutCache']) ||
      !isMediaId(source.mediaId) ||
      !isHash(source.sha256) ||
      !isRecord(source.layoutCache) ||
      !hasExactKeys(source.layoutCache, ['sourceSha256', 'analyzerModel', 'schemaVersion']) ||
      !isHash(source.layoutCache.sourceSha256) ||
      source.layoutCache.sourceSha256 !== source.sha256 ||
      !isNonBlankModel(source.layoutCache.analyzerModel) ||
      source.layoutCache.schemaVersion !== 1 ||
      !requestedSource('LAYOUT_REFERENCE', source.mediaId, source.sha256)
    ) return null;
    return { type: 'LAYOUT_REFERENCE' as const, mediaId: source.mediaId, sha256: source.sha256, layoutCache: { sourceSha256: source.layoutCache.sourceSha256, analyzerModel: source.layoutCache.analyzerModel, schemaVersion: 1 as const } };
  });
  if (analysisSources.some((source) => !source)) return null;

  let logoOverlaySource: CreativeGenerationProvenance['logoOverlaySource'];
  if ('logoOverlaySource' in value) {
    if (!isRecord(value.logoOverlaySource) || !hasExactKeys(value.logoOverlaySource, ['mediaId', 'sha256']) || !isMediaId(value.logoOverlaySource.mediaId) || !isHash(value.logoOverlaySource.sha256)) return null;
    logoOverlaySource = { mediaId: value.logoOverlaySource.mediaId, sha256: value.logoOverlaySource.sha256 };
  }

  let revision: CreativeGenerationProvenance['revision'];
  if ('revision' in value) {
    const source = value.revision;
    if (!isRecord(source) || !hasExactKeys(source, ['parentCreativeId', 'canvasMediaId', 'canvasSha256', ...('instruction' in source ? ['instruction'] : [])]) ||
      typeof source.parentCreativeId !== 'string' || !/^creative_[a-f0-9]{32}$/.test(source.parentCreativeId) ||
      !isMediaId(source.canvasMediaId) || !isHash(source.canvasSha256) ||
      ('instruction' in source && (typeof source.instruction !== 'string' || !source.instruction.trim() || source.instruction.length > 4000))) return null;
    revision = { parentCreativeId: source.parentCreativeId, canvasMediaId: source.canvasMediaId, canvasSha256: source.canvasSha256,
      ...(typeof source.instruction === 'string' ? { instruction: source.instruction } : {}) };
  }

  return {
    version: 1,
    imageGeneration: {
      prompt: value.imageGeneration.prompt,
      model: value.imageGeneration.model,
      ...(routing ? { routing } : {}),
    },
    requestedSources: validRequestedSources,
    attachedSource,
    analysisSources: analysisSources as CreativeGenerationProvenance['analysisSources'],
    ...(logoOverlaySource ? { logoOverlaySource } : {}),
    ...(revision ? { revision } : {}),
  };
};
