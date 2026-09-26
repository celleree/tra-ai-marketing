import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';
import { parseSourceOverlayDecision, type SourceCrop, type SourceOverlayDecision } from '@/lib/video/source-overlay-contract';
export type ProviderVideoFrame = ApprovedTraVideoFrame & {
  providerBuffer: Buffer;
  providerPngSha256: string;
  crop: SourceCrop | null;
};

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export const cropForSourceOverlay = (decision: SourceOverlayDecision, width: number, height: number): SourceCrop | null => {
  if (decision.status !== 'EDGE_CROP') return null;
  const axis = decision.edge === 'TOP' || decision.edge === 'BOTTOM' ? height : width;
  const removed = Math.ceil(axis * decision.removePermille / 1000);
  if (removed < 1 || removed >= axis || axis - removed < 2) throw new Error('Source overlay crop would leave insufficient portrait pixels.');
  if (decision.edge === 'TOP') return { left: 0, top: removed, width, height: height - removed };
  if (decision.edge === 'BOTTOM') return { left: 0, top: 0, width, height: height - removed };
  if (decision.edge === 'LEFT') return { left: removed, top: 0, width: width - removed, height };
  return { left: 0, top: 0, width: width - removed, height };
};

/** The extracted approved PNG remains immutable; only this derivative may be attached to image edits. */
export const prepareProviderVideoFrames = async (frames: readonly ApprovedTraVideoFrame[]): Promise<ProviderVideoFrame[]> =>
  Promise.all(frames.map(async (frame) => {
    if (hash(frame.buffer) !== frame.frameSha256 || frame.byteLength !== frame.buffer.length) {
      throw new Error('Approved TRA video frame integrity changed before image attachment.');
    }
    const decision = parseSourceOverlayDecision(frame.sourceOverlay);
    if (!decision || decision.status === 'UNSAFE') {
      throw new Error('TRA human source lacks a safe current overlay assessment. Select an unmarked approved frame or start a new portfolio.');
    }
    const metadata = await sharp(frame.buffer).metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error('Approved TRA video frame is not a valid PNG.');
    const crop = cropForSourceOverlay(decision, metadata.width, metadata.height);
    if (frame.expectedCrop !== undefined && JSON.stringify(frame.expectedCrop) !== JSON.stringify(crop)) {
      throw new Error('Saved sanitized TRA frame crop changed. Start a new creative from an assessed frame.');
    }
    const providerBuffer = crop ? await sharp(frame.buffer).extract(crop).png().toBuffer() : frame.buffer;
    const providerPngSha256 = hash(providerBuffer);
    if (frame.expectedProviderPngSha256 && frame.expectedProviderPngSha256 !== providerPngSha256) {
      throw new Error('Saved sanitized TRA frame pixels changed. Start a new creative from an assessed frame.');
    }
    return { ...frame, providerBuffer, providerPngSha256, crop };
  }));
