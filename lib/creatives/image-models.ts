import { assertLiveImageGenerationAllowed } from '@/lib/creatives/image-provider-admission';
import { imageRenderPurpose, prepareImageRenderRequest } from '@/lib/creatives/image-render-request';
import { executeImageAttempt } from '@/lib/creatives/image-attempt-execution';
import { CreativeImageProviderError, imageProviderFailure } from '@/lib/creatives/image-provider-failure';
export { CreativeImageProviderError, creativeImageHttpError, creativeImageMissingOutputError } from '@/lib/creatives/image-provider-failure';

export * from '@/lib/creatives/image-routing';
import { PREFERRED_CREATIVE_IMAGE_MODEL, FALLBACK_CREATIVE_IMAGE_MODEL,
  type CreativeImageModel, type CreativeImageOperationType, type CreativeImageRouting } from '@/lib/creatives/image-routing';

export async function fetchCreativeImage(
  input: string,
  init: RequestInit
) {
  assertLiveImageGenerationAllowed();
  const request = prepareImageRenderRequest(input, init);
  try {
    const response = await executeImageAttempt(input, request, () => fetch(input, request));
    if (!response.ok) throw await imageProviderFailure(response);
    return response;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CreativeImageProviderError(
        'OpenAI image request could not reach the provider.',
        null, 'UNKNOWN'
      );
    }
    throw error;
  }
}

const transientReason = (error: unknown) => {
  if (error instanceof CreativeImageProviderError && error.outcome === 'FAILED'
    && ['rate_limited', 'provider_unavailable'].includes(error.fallbackReason ?? '')) return error.fallbackReason;
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
    if (!fallbackReason || purpose !== 'production') throw error;
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
