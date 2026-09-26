import { isDeploymentRuntimeConsistent } from '@/lib/runtime/deployment';

/** Server environment only. Credentials and request data never grant admission. */
export function assertLiveImageGenerationAllowed(): void {
  const authorization = process.env.TRA_LIVE_IMAGE_AUTHORIZATION;
  const explicitAuthorization = authorization === 'allow-paid-image-generation';
  const validConfiguration = !authorization || explicitAuthorization;
  const automated = Boolean(process.env.CI || process.env.VITEST)
    || process.env.NODE_ENV === 'test';
  // NODE_ENV=production alone also describes local `next start`.
  const deployedProduction = process.env.NODE_ENV === 'production'
    && process.env.VERCEL_ENV === 'production' && !automated;

  if (isDeploymentRuntimeConsistent() && validConfiguration
    && (explicitAuthorization || deployedProduction)) return;

  throw new Error('Live image generation is disabled. For an intentional paid image call, '
    + 'set server-only TRA_LIVE_IMAGE_AUTHORIZATION=allow-paid-image-generation. '
    + 'Vercel production also requires NODE_ENV=production; tests and CI require explicit authorization.');
}
