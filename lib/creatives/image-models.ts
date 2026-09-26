import { assertLiveImageGenerationAllowed } from '@/lib/creatives/image-provider-admission';

export const PREFERRED_CREATIVE_IMAGE_MODEL = 'gpt-image-2.5-sunburst' as const;
export const FALLBACK_CREATIVE_IMAGE_MODEL = 'gpt-image-2.5-flare' as const;

export type CreativeImageModel =
  | typeof PREFERRED_CREATIVE_IMAGE_MODEL
  | typeof FALLBACK_CREATIVE_IMAGE_MODEL;

export const CREATIVE_IMAGE_OPERATION_TYPES = [
  'PROMPT_GENERATION',
  'LAYOUT_REFERENCE_GENERATION',
  'TRA_REFERENCE_GENERATION',
  'TRA_VIDEO_FRAME_GENERATION',
  'EDIT',
  'REGENERATE',
  'VARIATION',
  'PLACEMENT',
] as const;

export type CreativeImageOperationType =
  (typeof CREATIVE_IMAGE_OPERATION_TYPES)[number];

export type CreativeImageRouting = {
  operationType: CreativeImageOperationType;
  preferredModel: CreativeImageModel;
  actualModel: CreativeImageModel;
  fallbackUsed: boolean;
  fallbackFromModel: CreativeImageModel | null;
  fallbackReason: string | null;
};

export class CreativeImageProviderError extends Error {
  constructor(
    message: string,
    readonly fallbackReason: string | null
  ) {
    super(message);
    this.name = 'CreativeImageProviderError';
  }
}

export const creativeImageHttpError = (status: number, message: string) =>
  new CreativeImageProviderError(
    message,
    status === 408
      ? 'provider_timeout'
      : status === 429
        ? 'rate_limited'
        : status >= 500
          ? 'provider_unavailable'
          : null
  );

export const creativeImageMissingOutputError = () =>
  new CreativeImageProviderError(
    'OpenAI returned no generated image.',
    'missing_provider_output'
  );

export async function fetchCreativeImage(
  input: string,
  init: RequestInit
) {
  assertLiveImageGenerationAllowed();
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CreativeImageProviderError(
        'OpenAI image request could not reach the provider.',
        'network_failure'
      );
    }
    throw error;
  }
}

const transientReason = (error: unknown) => {
  if (error instanceof CreativeImageProviderError) return error.fallbackReason;
  return null;
};

export async function runCreativeImageModelRoute<T>(args: {
  operationType: CreativeImageOperationType;
  generate: (model: CreativeImageModel) => Promise<T>;
}): Promise<{ value: T; routing: CreativeImageRouting }> {
  try {
    return {
      value: await args.generate(PREFERRED_CREATIVE_IMAGE_MODEL),
      routing: {
        operationType: args.operationType,
        preferredModel: PREFERRED_CREATIVE_IMAGE_MODEL,
        actualModel: PREFERRED_CREATIVE_IMAGE_MODEL,
        fallbackUsed: false,
        fallbackFromModel: null,
        fallbackReason: null,
      },
    };
  } catch (error) {
    const fallbackReason = transientReason(error);
    if (!fallbackReason) throw error;
    return {
      value: await args.generate(FALLBACK_CREATIVE_IMAGE_MODEL),
      routing: {
        operationType: args.operationType,
        preferredModel: PREFERRED_CREATIVE_IMAGE_MODEL,
        actualModel: FALLBACK_CREATIVE_IMAGE_MODEL,
        fallbackUsed: true,
        fallbackFromModel: PREFERRED_CREATIVE_IMAGE_MODEL,
        fallbackReason,
      },
    };
  }
}

export const isCreativeImageModel = (
  value: unknown
): value is CreativeImageModel =>
  value === PREFERRED_CREATIVE_IMAGE_MODEL ||
  value === FALLBACK_CREATIVE_IMAGE_MODEL;

export const isCreativeImageOperationType = (
  value: unknown
): value is CreativeImageOperationType =>
  typeof value === 'string' &&
  CREATIVE_IMAGE_OPERATION_TYPES.includes(value as CreativeImageOperationType);
