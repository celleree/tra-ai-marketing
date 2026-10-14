import { beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createHash, randomBytes } from 'node:crypto';
import { videoCasePortfolio } from '../fixtures/video-case-portfolio';
import { proposeCaseAmendment } from '@/lib/creatives/portfolio-case-amendment';
import { portfolioPortraitDiagnostic } from '@/lib/creatives/portfolio-portrait-diagnostic';
import { providerPortraitIdentity, providerPortraitInput } from '@/lib/video/provider-portrait';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
const mocks = vi.hoisted(() => ({ read: vi.fn(), inventory: vi.fn(), extract: vi.fn() }));
vi.mock('@/lib/video/candidate-suitability', () => ({ readCandidateSuitability: mocks.read }));
vi.mock('@/lib/creatives/generation-sources', () => ({ hydratePlanningSourceInventory: mocks.inventory }));
vi.mock('@/lib/creatives/portfolio-video-selection', () => ({ hydratePortfolioVideoFrameSelection: mocks.extract }));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const quality = { humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes: 'UNCERTAIN', blur: 'CLEAR', occlusion: 'NONE_OR_MINOR',
  expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE', sourceOverlay: { status: 'UNSAFE' }, observableReason: 'Eyes uncertain; visible mark remains.' };
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue({ status: 'COMPLETE', assessment: quality }); mocks.inventory.mockResolvedValue([{ source: {} }]); });
async function fixture(inputBuffer?: Buffer) {
  const { job, pairs, frames } = videoCasePortfolio(); job.snapshot!.sourceAnalysis = {} as never; job.videoCaseAmendment = proposeCaseAmendment(job, pairs).amendment;
  const buffer = inputBuffer ?? await sharp({ create: { width: 600, height: 600, channels: 3, background: 'white' } }).png().toBuffer();
  const frame = { buffer, frameSha256: hash(buffer), byteLength: buffer.length, timestampMs: frames[1].timestampMs,
    sourceVideoMediaId: job.request.sourceAssets[0].mediaId, sourceVideoContentHash: 'a'.repeat(64),
    sourceOverlay: { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 450, overlayDepthPermille: 400 } };
  const selection = { version: 3, sourceVideoMediaId: frame.sourceVideoMediaId, sourceVideoContentHash: frame.sourceVideoContentHash,
    librarySha256: 'b'.repeat(64), candidateBindings: [{ ...frames[1], representativeFrameId: frames[1].frameId }], sourceOverlays: [frame.sourceOverlay] } as never;
  const [prepared] = await prepareProviderVideoFrames([frame as never]);
  const { state, identity } = await providerPortraitInput(selection, prepared, 'gpt-6-luna');
  job.slots[1].videoSelection = { version: 2, selection, providerPortrait: state, selectionModel: 'gpt-6-luna' } as never;
  mocks.extract.mockResolvedValue({ frames: [frame] });
  return { job, frame, identity, prepared };
}
it('reads exact cached fields and hash-pinned PNG without changing job, storage or dispatching AI', async () => {
  const { job, identity, prepared } = await fixture(); const original = structuredClone(job);
  const storage = { read: vi.fn(), write: vi.fn() } as never;
  const result = await portfolioPortraitDiagnostic(job, 2, storage);
  expect(mocks.read).toHaveBeenCalledWith(identity, expect.objectContaining({ storage }));
  expect(result.failedChecks).toEqual(['eyes', 'sourceOverlay']); expect(result.assessment).toEqual(quality);
  expect(result.originalDimensions).toEqual({ width: 600, height: 600 });
  expect(result.cropDecision).toEqual({ version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 450, overlayDepthPermille: 400 });
  expect(result.frameIdentity.caseFrameId).toBe(result.frameIdentity.selectedFrameId);
  expect(result.frameIdentity.caseTimestampMs).toBe(result.timestampMs);
  expect(Buffer.from(result.originalPng!.dataUrl.split(',')[1], 'base64')).toEqual(prepared.buffer);
  expect(result.png).toMatchObject({ width: 600, height: 330, matchesPinned: true });
  expect(Buffer.from(result.png!.dataUrl.split(',')[1], 'base64')).toEqual(prepared.providerBuffer);
  expect(job).toEqual(original); expect((storage as { write: ReturnType<typeof vi.fn> }).write).not.toHaveBeenCalled();
  expect(providerPortraitIdentity(job.slots[1].videoSelection!.selection!, (job.slots[1].videoSelection as Extract<NonNullable<typeof job.slots[1]['videoSelection']>, { version: 2 }>).providerPortrait!, 'gpt-6-luna')).toEqual(identity);
});
it.each(['original', 'provider', 'crop'])('keeps cached rejection but refuses substituted pixels when %s differs', async field => {
  const { job, frame } = await fixture();
  if (field === 'original') mocks.extract.mockResolvedValue({ frames: [{ ...frame, buffer: Buffer.from('different') }] });
  if (field === 'provider') (job.slots[1].videoSelection as Extract<NonNullable<typeof job.slots[1]['videoSelection']>, { version: 2 }>).providerPortrait!.providerPngSha256 = 'c'.repeat(64);
  if (field === 'crop') (job.slots[1].videoSelection as Extract<NonNullable<typeof job.slots[1]['videoSelection']>, { version: 2 }>).providerPortrait!.crop!.height -= 1;
  const result = await portfolioPortraitDiagnostic(job, 2, {} as never);
  expect(result.png).toBeNull(); expect(result.originalPng).toBeNull(); expect(result.failedChecks).toEqual(['eyes', 'sourceOverlay']); expect(result.previewError).toContain('no pixels were substituted');
});
it('refuses active job before any cache or source reads', async () => {
  const { job } = await fixture(); job.lease = { id: 'active', slotIndex: 2, expiresAtMs: Date.now() + 1000 };
  await expect(portfolioPortraitDiagnostic(job, 2, {} as never)).rejects.toThrow('paused');
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.extract).not.toHaveBeenCalled();
});

it('refuses a different selected timestamp instead of relabeling it as the confirmed case', async () => {
  const { job } = await fixture(); job.slots[1].videoSelection!.selection!.candidateBindings![0].timestampMs += 2000;
  await expect(portfolioPortraitDiagnostic(job, 2, {} as never)).rejects.toThrow('confirmed case frame');
  expect(mocks.extract).not.toHaveBeenCalled();
});

it('shares the inline byte budget and never resizes an oversized uncropped comparison', async () => {
  const source = await sharp(randomBytes(600 * 1200 * 3), { raw: { width: 600, height: 1200, channels: 3 } }).png().toBuffer();
  const { job } = await fixture(source); const result = await portfolioPortraitDiagnostic(job, 2, {} as never);
  expect(result.png).not.toBeNull(); expect(result.originalPng).toBeNull();
  expect(result.originalDimensions).toEqual({ width: 600, height: 1200 });
  expect(result.originalPreviewError).toContain('no resized image');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4_000_000);
});
