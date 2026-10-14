import { isDeepStrictEqual } from 'node:util';
import type { SourceCrop } from '@/lib/video/source-overlay-contract';

export type ProviderPortraitState = { version: 1; providerPngSha256: string; sourcePngSha256: string;
  crop: SourceCrop | null; verified: boolean; retryAuthorized?: true };
export function validProviderPortraitState(value: unknown): value is ProviderPortraitState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as ProviderPortraitState;
  return item.version === 1 && /^[a-f0-9]{64}$/.test(item.providerPngSha256) && /^[a-f0-9]{64}$/.test(item.sourcePngSha256)
    && typeof item.verified === 'boolean' && (item.retryAuthorized === undefined || (item.retryAuthorized === true && !item.verified))
    && Object.keys(item).length === (item.retryAuthorized ? 6 : 5)
    && (item.crop === null || (item.crop && typeof item.crop === 'object' && !Array.isArray(item.crop) && Object.keys(item.crop).sort().join(',') === 'height,left,top,width'
      && Object.values(item.crop).every(value => Number.isSafeInteger(value) && value >= 0)
      && item.crop.width >= 2 && item.crop.height >= 2));
}
export function sameProviderPortrait(a: ProviderPortraitState, b: ProviderPortraitState) {
  return a.providerPngSha256 === b.providerPngSha256 && a.sourcePngSha256 === b.sourcePngSha256 && isDeepStrictEqual(a.crop, b.crop);
}
