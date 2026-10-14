import { isDeepStrictEqual } from 'node:util';
import { parseSourceOverlayDecision } from '@/lib/video/source-overlay-contract';
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

export type PortraitCropRevision = {
  version: 1; previousPortrait: ProviderPortraitState; previousOverlay: import('@/lib/video/source-overlay-contract').SourceOverlayDecision;
  previousAssessmentKeySha256: string; previousError: string; originalWidth: number; originalHeight: number;
  frameId: string; timestampMs: number; sourceVideoContentHash: string;
  revisedOverlay: import('@/lib/video/source-overlay-contract').SourceOverlayDecision;
  assessmentAttempted: boolean; imageAuthorized: boolean;
};
export function validPortraitCropRevision(value: unknown): value is PortraitCropRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const x = value as PortraitCropRevision;
  return Object.keys(x).sort().join(',') === ['version','previousPortrait','previousOverlay','previousAssessmentKeySha256','previousError','originalWidth','originalHeight','frameId','timestampMs','sourceVideoContentHash','revisedOverlay','assessmentAttempted','imageAuthorized'].sort().join(',')
    && x.version === 1 && validProviderPortraitState(x.previousPortrait) && !x.previousPortrait.verified
    && /^[a-f0-9]{64}$/.test(x.previousAssessmentKeySha256) && typeof x.previousError === 'string' && x.previousError.length > 0 && x.previousError.length <= 1000
    && Number.isSafeInteger(x.originalWidth) && x.originalWidth >= 256 && Number.isSafeInteger(x.originalHeight) && x.originalHeight >= 256
    && typeof x.frameId === 'string' && /^video-frame:[a-f0-9]{64}$/.test(x.frameId) && Number.isSafeInteger(x.timestampMs) && x.timestampMs >= 0
    && /^[a-f0-9]{64}$/.test(x.sourceVideoContentHash) && !!parseSourceOverlayDecision(x.previousOverlay)
    && !!parseSourceOverlayDecision(x.revisedOverlay) && x.revisedOverlay.status === 'EDGE_CROP'
    && typeof x.assessmentAttempted === 'boolean' && typeof x.imageAuthorized === 'boolean' && (!x.imageAuthorized || x.assessmentAttempted);
}
