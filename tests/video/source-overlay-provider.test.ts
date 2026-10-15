import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApprovedTraVideoFrameCreativeImage } from '@/lib/ai/video-frame-generation';
import { generateLegacyApprovedTraVideoFrameCreativeImage } from '@/lib/ai/legacy-copy-image-generation';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const original = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ad6644' } })
  .composite([{ input: await sharp({ create: { width: 100, height: 40, channels: 3, background: '#0739af' } }).png().toBuffer(),
    left: 0, top: 60 }]).png().toBuffer();
const frame = (sourceOverlay?: ApprovedTraVideoFrame['sourceOverlay']): ApprovedTraVideoFrame => ({
  frameIndex: 0, timestampMs: 1333, mimeType: 'image/png', buffer: Buffer.from(original), frameSha256: sha(original),
  byteLength: original.length, sourceRole: 'TRA_VIDEO', sourceVideoMediaId: `media_${'a'.repeat(32)}`,
  sourceVideoFileName: 'synthetic.mp4', sourceVideoContentHash: 'b'.repeat(64), approvedHumanSource: true,
  cacheKey: null, sourceOverlay,
});
const crop = { version: 2 as const, status: 'EDGE_CROP' as const, edge: 'BOTTOM' as const,
  removePermille: 400, overlayDepthPermille: 400 };
const output = () => Response.json({ data: [{ b64_json: original.toString('base64') }] });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('provider-bound source-overlay decision', () => {
  it('keeps a clean approved PNG byte-identical and leaves its original untouched', async () => {
    const source = frame({ version: 2, status: 'CLEAN' });
    const [prepared] = await prepareProviderVideoFrames([source]);
    expect(prepared.providerBuffer).toEqual(original);
    expect(prepared.providerPngSha256).toBe(source.frameSha256);
    expect(prepared.crop).toBeNull();
    expect(source.buffer).toEqual(original);
  });

  it('sends only source pixels above the removable lower third through current and legacy image edits', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
    const requests: Array<{ url: string; form: FormData }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, form: init.body as FormData }); return output();
    }));
    const source = frame(crop);
    const current = await generateApprovedTraVideoFrameCreativeImage({ frames: [source], primaryFormat: 'direct-response',
      context: 'Synthetic portrait', copy: { headline: 'Talk with TRA' } });
    const legacy = await generateLegacyApprovedTraVideoFrameCreativeImage({ frames: [source], primaryFormat: 'direct-response',
      context: 'Synthetic portrait', copy: { headline: 'Talk with TRA', primaryText: '', description: '' } });
    expect(requests).toHaveLength(2);
    const expectedRaw = await sharp(original).extract({ left: 0, top: 0, width: 100, height: 60 }).raw().toBuffer();
    for (const request of requests) {
      expect(request.url).toContain('/images/edits');
      const image = request.form.getAll('image[]')[0] as File;
      const sent = Buffer.from(await image.arrayBuffer());
      expect((await sharp(sent).metadata()).height).toBe(60);
      expect(await sharp(sent).raw().toBuffer()).toEqual(expectedRaw);
      expect(image.name).toContain('approved-tra-video-');
      expect(sha(sent)).toBe(current.providerFrames[0].providerPngSha256);
    }
    expect(current.providerFrames[0].crop).toEqual({ left: 0, top: 0, width: 100, height: 60 });
    expect(legacy.providerFrames[0].providerPngSha256).toBe(current.providerFrames[0].providerPngSha256);
    expect(source.buffer).toEqual(original);
    expect(source.frameSha256).toBe(sha(original));
  });

  it('rejects unsafe, missing and invalid non-edge decisions before any image request', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
    const outbound = vi.fn(); vi.stubGlobal('fetch', outbound);
    for (const decision of [undefined, { version: 2, status: 'UNSAFE' } as const,
      { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 500, overlayDepthPermille: 400 } as const]) {
      await expect(generateApprovedTraVideoFrameCreativeImage({ frames: [frame(decision)], primaryFormat: 'direct-response',
        context: 'Synthetic portrait', copy: { headline: 'Talk with TRA' } })).rejects.toThrow('safe current overlay assessment');
    }
    expect(outbound).not.toHaveBeenCalled();
    await expect(prepareProviderVideoFrames([])).rejects.toThrow('one to three assessed frames');
  });
});
