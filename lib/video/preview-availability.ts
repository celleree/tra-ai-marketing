/** Durable video workflows are available in local development and protected Preview.
 * Production requires the configuration needed by the authenticated,
 * storage-backed provider path. This is not a credential-health check. */
const REQUIRED_PRODUCTION_VIDEO_VARIABLES = [
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
  'OPENAI_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
] as const;

const hasRequiredProductionVideoConfiguration = () =>
  REQUIRED_PRODUCTION_VIDEO_VARIABLES.every((name) => Boolean(process.env[name]?.trim()))
  && /^pk_live_\S+$/.test(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '')
  && /^sk_live_\S+$/.test(process.env.CLERK_SECRET_KEY ?? '');

export const isDurableVideoIntelligenceAvailable = () => {
  const vercelEnvironment = process.env.VERCEL_ENV;

  if (vercelEnvironment === 'production') {
    return hasRequiredProductionVideoConfiguration();
  }

  if (vercelEnvironment === 'preview') return true;
  if (vercelEnvironment && vercelEnvironment !== 'development') return false;
  return process.env.NODE_ENV !== 'production';
};

export const assertDurableVideoIntelligenceAvailable = () => {
  if (!isDurableVideoIntelligenceAvailable()) {
    throw new Error('Video intelligence is available in local development, protected Vercel Preview, or configured Production only.');
  }
};

export const videoIntelligenceHttpStatus = (status: number) =>
  isDurableVideoIntelligenceAvailable() ? status : 404;
