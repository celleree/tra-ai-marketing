/** Durable video workflows may be tested in protected Preview deployments.
 * Production remains gated until application authorization is in place. */
export const isDurableVideoIntelligenceAvailable = () =>
  process.env.NODE_ENV !== 'production' || process.env.VERCEL_ENV === 'preview';

export const assertDurableVideoIntelligenceAvailable = () => {
  if (!isDurableVideoIntelligenceAvailable()) {
    throw new Error('Video intelligence is available in local development or protected Vercel Preview only.');
  }
};

export const videoIntelligenceHttpStatus = (status: number) =>
  isDurableVideoIntelligenceAvailable() ? status : 404;
