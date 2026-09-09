/** Hosted Production/Preview must never inherit local-development fallbacks. */
export const isDeploymentRuntimeConsistent = (): boolean =>
  (process.env.VERCEL_ENV !== 'production' && process.env.VERCEL_ENV !== 'preview')
  || process.env.NODE_ENV === 'production';

export const assertDeploymentRuntimeConsistent = (): void => {
  if (!isDeploymentRuntimeConsistent()) {
    throw new Error('Vercel Production and Preview require NODE_ENV=production.');
  }
};
