import { assertLiveImageGenerationAllowed } from '@/lib/creatives/image-provider-admission';
import { imageRenderPurpose, prepareImageRenderRequest } from '@/lib/creatives/image-render-request';
import { executeImageAttempt } from '@/lib/creatives/image-attempt-execution';

export * from '@/lib/creatives/image-routing';
import { PREFERRED_CREATIVE_IMAGE_MODEL, FALLBACK_CREATIVE_IMAGE_MODEL,
  type CreativeImageModel, type CreativeImageOperationType, type CreativeImageRouting } from '@/lib/creatives/image-routing';

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
  const request = prepareImageRenderRequest(input, init);
  try {
    return await executeImageAttempt(input, request, () => fetch(input, request));
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
  const purpose = imageRenderPurpose();
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
    if (!fallbackReason || purpose === 'diagnostic') throw error;
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
