import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

const mocks = vi.hoisted(() => ({ saveBatch: vi.fn() }));
vi.mock('@/lib/creatives/storage', () => ({ saveCreativeBatch: mocks.saveBatch }));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('final non-human provider boundary', () => {
  it.each([false, true])('sends no video frames for %s copy while retaining the selected document', async legacy => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#123047' } }).png().toBuffer();
    const outbound = vi.fn().mockResolvedValue(Response.json({ data: [{ b64_json: png.toString('base64') }] }));
    vi.stubGlobal('fetch', outbound);
    mocks.saveBatch.mockImplementation(async records => records.map((record: object) => ({ ...record, createdAt: '2026-09-23T00:00:00.000Z' })));
    const request = { ...portfolioRequest(), sourceAssets: [{ role: 'TRA_VIDEO' as const, mediaId: `media_${'a'.repeat(32)}` }] };
    const snapshot = portfolioSnapshot(newCreativePortfolio(request));
    const concept = snapshot.batchPlan.creatives[0];
    concept.strategy.execution.taxDocumentReference = 'irs-notice-v1';
    if (legacy) { delete concept.adCopy; delete concept.imageCopy; }
    const frame = { sourceVideoMediaId: request.sourceAssets[0].mediaId, sourceVideoContentHash: 'b'.repeat(64),
      frameSha256: 'c'.repeat(64), timestampMs: 1000, buffer: png, mimeType: 'image/png' } as any;
    const storage = { saveImage: vi.fn(async (file: File) => {
      expect(await sharp(Buffer.from(await file.arrayBuffer())).metadata()).toMatchObject({ width: 1024, height: 1024 });
      return { id: `media_${'d'.repeat(32)}`, fileName: 'output.png', originalName: 'output.png',
        mimeType: 'image/png', size: file.size, url: '/output.png' };
    }) } as any;
    const creative = await renderPlannedCreative(concept, {
      request, batchPlan: snapshot.batchPlan, referenceCatalog: [], selectedReferences: [],
      requestedSources: [{ role: 'TRA_VIDEO', mediaId: frame.sourceVideoMediaId, sha256: 'b'.repeat(64) }],
      analysisSources: [], reserveLogoArea: false, brandLogo: null, providerImageSource: undefined,
      videoFrameSet: { source: {}, frames: [frame] } as any,
      generatedVideoFrameSelection: { libraryId: `video-library:${'e'.repeat(64)}`, sourceVideoMediaId: frame.sourceVideoMediaId,
        sourceVideoContentHash: frame.sourceVideoContentHash, frames: [] }, storage,
    }, { creativeId: `creative_${'f'.repeat(32)}` });
    expect(outbound).toHaveBeenCalledOnce();
    expect(outbound.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/edits');
    const form = outbound.mock.calls[0][1].body as FormData;
    expect(Array.from(form.getAll('image[]'))).toHaveLength(1);
    expect((form.getAll('image[]')[0] as File).name).toContain('irs-notice');
    expect(creative.generationProvenance!.attachedSource).toBeNull();
    expect(creative.videoFrameSelection).toBeUndefined();
    expect(creative.generationProvenance!.requestedSources).toHaveLength(1);
  });
});
