import { createHash } from 'node:crypto';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { parseCreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { parseCreativeIdentity } from '@/lib/creatives/identity';
import { fingerprintCreativeStrategy } from '@/lib/creatives/identity.server';
import { isCreativePlacement } from '@/lib/creatives/placements';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';
import { parseCreativeStrategy } from '@/lib/creatives/strategy';
import {
  CreativeSourceHydrationError,
  hydrateCreativeSourceSelections,
  type EligibleProviderImageSource,
  type HydratedCreativeSourceAsset,
} from '@/lib/media/source-hydration';
import { isCreativeFormat } from '@/lib/creative-formats';
import { validateStoredMedia, type MediaStorage } from '@/lib/media/storage';
import type { AllowedImageMimeType } from '@/lib/media/types';
import { parseApprovedHumanSourceId } from '@/lib/video/approved-human';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';
import { resolveRevisionVideoFrames } from '@/lib/video/revision-frames';
import { requireActiveHumanSelection } from '@/lib/video/approved-human-service';

const sha256 = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

export class CreativeRevisionHydrationError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
    this.name = 'CreativeRevisionHydrationError';
  }
}

type EditingCanvas = {
  kind: 'EDITING_CANVAS'; approvedHumanSource: false; mediaId: string;
  fileName: string; mimeType: AllowedImageMimeType; buffer: Buffer; sha256: string;
};
type LogoOverlay = {
  kind: 'LOGO_OVERLAY'; mediaId: string; fileName: string;
  mimeType: AllowedImageMimeType; buffer: Buffer; sha256: string;
};
type OriginalApprovedSource = null
  | { kind: 'TRA_REFERENCE'; source: EligibleProviderImageSource; sha256: string }
  | { kind: 'TRA_VIDEO_FRAMES'; source: HydratedCreativeSourceAsset; selectionMode: 'AUTOMATIC' | 'USER_SELECTED'; frames: ApprovedTraVideoFrame[] };

const reject = (message: string): never => {
  throw new CreativeRevisionHydrationError(message, 409);
};

const mapHydrationError = (error: unknown): never => {
  if (error instanceof CreativeSourceHydrationError ||
    (typeof error === 'object' && error !== null && 'status' in error)) {
    const sourceError = error as { message?: unknown; status?: unknown };
    throw new CreativeRevisionHydrationError(
      typeof sourceError.message === 'string' ? sourceError.message : 'Saved creative context could not be hydrated.',
      sourceError.status === 404 ? 404 : 409
    );
  }
  throw new CreativeRevisionHydrationError(
    error instanceof Error ? error.message : 'Saved creative context could not be hydrated.',
    409
  );
};

const reloadImage = async (
  storage: MediaStorage,
  mediaId: string,
  expected?: { fileName?: string; mimeType?: string; size?: number; sha256?: string }
) => {
  const stored = await storage.readImageById(mediaId);
  if (!stored) {
    throw new CreativeRevisionHydrationError(`Saved image ${mediaId} could not be found.`, 404);
  }
  try {
    validateStoredMedia({ ...stored, mediaType: 'IMAGE' });
  } catch (error) {
    reject(error instanceof Error ? error.message : 'Saved image is invalid.');
  }
  if (
    expected &&
    ((expected.fileName !== undefined && stored.fileName !== expected.fileName) ||
      (expected.mimeType !== undefined && stored.mimeType !== expected.mimeType) ||
      (expected.size !== undefined && stored.buffer.length !== expected.size) ||
      (expected.sha256 !== undefined && sha256(stored.buffer) !== expected.sha256))
  ) {
    reject('Saved image metadata or pixels have changed.');
  }
  return stored;
};

const hydrateAttachedSource = async (
  parent: CreativeRecord,
  storage: MediaStorage,
  provenance: NonNullable<CreativeRecord['generationProvenance']>
) => {
  const attached = provenance.attachedSource;
  if (!attached) return null;
  const role = attached.type === 'TRA_REFERENCE_IMAGE' ? 'TRA_REFERENCE' : 'TRA_VIDEO';
  let sources: HydratedCreativeSourceAsset[];
  try {
    sources = await hydrateCreativeSourceSelections(storage, [{ mediaId: attached.mediaId, role }]);
  } catch (error) {
    return mapHydrationError(error);
  }
  const source = sources[0];
  const expectedHash = attached.type === 'TRA_REFERENCE_IMAGE'
    ? attached.sha256
    : attached.sourceSha256;
  if (!source || sha256(source.stored.buffer) !== expectedHash) {
    reject('The saved original TRA source has changed or does not match this creative.');
  }
  if (attached.type === 'TRA_REFERENCE_IMAGE') {
    if (source.role !== 'TRA_REFERENCE' || source.media.mediaType !== 'IMAGE' || source.stored.mediaType !== 'IMAGE') {
      reject('Saved TRA reference provenance is invalid.');
    }
    return { kind: 'TRA_REFERENCE' as const, source: source as EligibleProviderImageSource, sha256: expectedHash };
  }
  try {
    const frames = await resolveRevisionVideoFrames(source, attached, parent.videoFrameSelection);
    return { kind: 'TRA_VIDEO_FRAMES' as const, source, selectionMode: attached.selectionMode, frames };
  } catch (error) {
    return mapHydrationError(error);
  }
};

export async function hydrateSavedCreativeRevisionContext(
  parent: CreativeRecord,
  storage: MediaStorage
): Promise<{
  parent: { record: CreativeRecord; identity: NonNullable<CreativeRecord['identity']>; planning: NonNullable<CreativeRecord['planning']>; provenance: NonNullable<CreativeRecord['generationProvenance']> };
  canvas: EditingCanvas;
  originalApprovedSource: OriginalApprovedSource;
  logoOverlay: LogoOverlay | null;
}> {
  const identity = parseCreativeIdentity(parent.identity, parent.id);
  const planning = parseCreativePlanning(parent.planning);
  const provenance = parseCreativeGenerationProvenance(parent.generationProvenance);
  if (!identity || !planning || !provenance || !parent.format || !isCreativeFormat(parent.format) || !parent.placement || !isCreativePlacement(parent.placement)) {
    throw new CreativeRevisionHydrationError(
      'Saved creative revision context is missing or invalid. Generate and save a new creative before revising this item.',
      409
    );
  }
  if (identity.fingerprint !== fingerprintCreativeStrategy(planning.strategy)) {
    reject('Saved creative identity does not match its planning strategy.');
  }
  const canvasStored = await reloadImage(storage, parent.image.id, parent.image);
  const humanRecordId = planning.strategy.humanSourceId
    ? parseApprovedHumanSourceId(planning.strategy.humanSourceId)
    : planning.strategy.approvedHumanId ?? null;
  if (planning.strategy.humanSourceId && !humanRecordId) reject('Saved creative planning contains an unsupported human source.');
  if (humanRecordId) {
    try { await requireActiveHumanSelection(humanRecordId, parent.videoFrameSelection); }
    catch (error) { return mapHydrationError(error); }
  }
  const originalApprovedSource = await hydrateAttachedSource(parent, storage, provenance);
  if (!parseCreativeStrategy(planning.strategy, originalApprovedSource !== null)) {
    reject('Saved creative planning requires an approved TRA source that is unavailable.');
  }
  const logo = provenance.logoOverlaySource
    ? await reloadImage(storage, provenance.logoOverlaySource.mediaId, {
        sha256: provenance.logoOverlaySource.sha256,
      }).catch((error: unknown) => {
        if (error instanceof CreativeRevisionHydrationError && error.status === 409 && error.message === 'Saved image metadata or pixels have changed.') {
          reject('Saved logo overlay metadata or pixels have changed.');
        }
        throw error;
      })
    : null;
  if (logo && !logo.fileName.startsWith(`${provenance.logoOverlaySource!.mediaId}.`)) {
    reject('Saved logo overlay metadata has changed.');
  }
  return {
    parent: { record: parent, identity, planning, provenance },
    canvas: { kind: 'EDITING_CANVAS', approvedHumanSource: false, mediaId: parent.image.id, fileName: canvasStored.fileName, mimeType: canvasStored.mimeType, buffer: canvasStored.buffer, sha256: sha256(canvasStored.buffer) },
    originalApprovedSource,
    logoOverlay: logo && provenance.logoOverlaySource ? { kind: 'LOGO_OVERLAY', mediaId: provenance.logoOverlaySource.mediaId, fileName: logo.fileName, mimeType: logo.mimeType, buffer: logo.buffer, sha256: sha256(logo.buffer) } : null,
  };
}
