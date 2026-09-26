import { createHash } from 'node:crypto';
import { getMediaStorage } from '@/lib/media/local-storage';
import { hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import { isSafeMediaId } from '@/lib/media/storage';
import { parseApprovedHumanFrame, type ApprovedHumanFrame } from '@/lib/video/approved-human';
import { approvedHumanId, listApprovedHumanFrames, saveApprovedHumanFrame, setApprovedHumanActive } from '@/lib/video/approved-human-store';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { isStructurallyValidPng } from '@/lib/video/frame-cache';
import { parseGenerateVideoFrameSelection, parseGeneratedVideoFrameSelection, type GenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { getVideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { videoSourceHash } from '@/lib/video/library-service';
import { assertDurableVideoIntelligenceAvailable } from '@/lib/video/preview-availability';
import { extractVideoSelectionFrames, loadVideoSelectionContext } from '@/lib/video/selection-context';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const previewKey = (id: string) => `approved-humans/v1/previews/${id}.png`;
const validPng = (bytes: Buffer, hash: string) => isStructurallyValidPng(bytes) && sha256(bytes) === hash;

async function freshSelection(mediaId: string, input: GenerateVideoFrameSelection, expectedPng: string) {
  assertDurableVideoIntelligenceAvailable();
  const selection = parseGenerateVideoFrameSelection(input);
  if (!isSafeMediaId(mediaId) || !selection || selection.frameIds.length !== 1 || !/^[a-f0-9]{64}$/.test(expectedPng)) {
    throw new Error('Choose one source frame and preview its PNG before approval.');
  }
  const [hydrated] = await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId, role: 'TRA_VIDEO' }]);
  const video = hydrated as HydratedTraVideoSource;
  if (videoSourceHash(video) !== selection.sourceVideoContentHash) throw new Error('The approved-human source video changed.');
  const context = await loadVideoSelectionContext(video);
  if (!context || context.library.id !== selection.libraryId) throw new Error('The approved-human source library is unavailable. Reanalyze the video.');
  const selected = await extractVideoSelectionFrames(video, context, selection.frameIds);
  const source = parseGeneratedVideoFrameSelection({ libraryId: selection.libraryId, sourceVideoMediaId: mediaId,
    sourceVideoContentHash: selection.sourceVideoContentHash, frames: selected.selectionProvenance });
  const frame = selected.frames[0];
  if (!source || source.frames.length !== 1 || source.frames[0].libraryFrameId !== selection.frameIds[0]
    || selected.frames.length !== 1 || !frame || !validPng(frame.buffer, expectedPng)
    || frame.frameSha256 !== expectedPng || source.frames[0].approvedPngSha256 !== expectedPng
    || source.frames[0].frameIndex !== frame.frameIndex || source.frames[0].timestampMs !== frame.timestampMs) {
    throw new Error('The fresh source PNG no longer matches the approved preview. Preview and approve again.');
  }
  return { source, selected };
}

export async function approveHumanFrame(input: {
  mediaId: string; selection: GenerateVideoFrameSelection; previewPngSha256: string; description: string;
}, approvedBy: string, storage = getVideoIntelligenceStorage()) {
  if (input.selection.version !== 2 || input.selection.sourceOverlays?.length !== 1) {
    throw new Error('This human frame is unassessed. Assess the exact source frame and approve it again.');
  }
  const { source, selected } = await freshSelection(input.mediaId, input.selection, input.previewPngSha256);
  if (selected.selectionProvenance.length !== 1 || selected.selectionProvenance[0].libraryFrameId !== input.selection.frameIds[0]) {
    throw new Error('The assessed human frame no longer matches its source selection. Reassess it.');
  }
  await prepareProviderVideoFrames([{ ...selected.frames[0], sourceOverlay: input.selection.sourceOverlays[0] }]);
  const now = new Date().toISOString();
  const record = parseApprovedHumanFrame({ version: 2, id: approvedHumanId(source, input.selection.sourceOverlays[0]), source,
    sourceOverlay: input.selection.sourceOverlays[0],
    sourceName: selected.source.media.fileName, description: input.description, extractionVersion: 'selected-png-v1',
    approvedBy, approvedAt: now, updatedAt: now, active: true });
  if (!record) throw new Error('Provide valid approval notes and operator identity.');
  const key = previewKey(record.id);
  const existing = await storage.read(key);
  if (existing && !validPng(existing.bytes, input.previewPngSha256)) throw new Error('The stored approval preview is invalid.');
  if (!existing && !await storage.write(key, selected.frames[0].buffer, null)) {
    const concurrent = await storage.read(key);
    if (!concurrent || !validPng(concurrent.bytes, input.previewPngSha256)) throw new Error('Could not save the approved preview.');
  }
  return saveApprovedHumanFrame(record, storage);
}

export async function getApprovedHumanFrame(id: string, storage = getVideoIntelligenceStorage()) {
  const record = (await listApprovedHumanFrames(storage)).find(item => item.id === id);
  if (!record) throw new Error('Approved human was not found.');
  return record;
}

/** Approval is separate from source extraction; revisions reuse their existing fresh-PNG validator. */
export async function requireActiveHumanSelection(id: string, selection: unknown, storage = getVideoIntelligenceStorage()) {
  const record = await getApprovedHumanFrame(id, storage);
  if (record.version !== 2) throw new Error('This historical approved human is unassessed. Reassess and approve the exact frame before reuse.');
  const source = parseGeneratedVideoFrameSelection(selection);
  if (!record.active || !source || JSON.stringify(source) !== JSON.stringify(record.source)) {
    throw new Error('The selected human is inactive or no longer matches this creative.');
  }
  return record;
}

async function validateApprovedSource(record: ApprovedHumanFrame) {
  if (record.version !== 2) throw new Error('This historical approved human is unassessed. Reassess and approve the exact frame before generation.');
  const { source, selected } = await freshSelection(record.source.sourceVideoMediaId, {
    libraryId: record.source.libraryId, sourceVideoContentHash: record.source.sourceVideoContentHash,
    frameIds: [record.source.frames[0].libraryFrameId], version: 2, sourceOverlays: [record.sourceOverlay],
  }, record.source.frames[0].approvedPngSha256);
  if (JSON.stringify(source) !== JSON.stringify(record.source)) throw new Error('Approved-human frame provenance changed.');
  return { ...selected, frames: selected.frames.map(frame => ({ ...frame, sourceOverlay: record.sourceOverlay })) };
}

/** Provider use always re-extracts the original source; cached previews are never a fallback. */
export async function resolveApprovedHumanFrame(id: string, storage = getVideoIntelligenceStorage()) {
  const record = await getApprovedHumanFrame(id, storage);
  if (!record.active) throw new Error('This approved human is inactive.');
  return { record, selected: await validateApprovedSource(record) };
}

export async function changeApprovedHumanActive(id: string, active: boolean, storage = getVideoIntelligenceStorage()) {
  assertDurableVideoIntelligenceAvailable();
  if (active) await validateApprovedSource(await getApprovedHumanFrame(id, storage));
  return setApprovedHumanActive(id, active, storage);
}

/** Historical curation preview only, including inactive records. */
export async function readApprovedHumanPreview(id: string, storage = getVideoIntelligenceStorage()) {
  const record = await getApprovedHumanFrame(id, storage);
  const stored = await storage.read(previewKey(record.id));
  if (!stored || !validPng(stored.bytes, record.source.frames[0].approvedPngSha256)) throw new Error('Approved preview is unavailable.');
  return stored.bytes;
}
