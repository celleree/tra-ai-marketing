import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessCandidateWithCache, type CandidateAssessmentIdentity } from '@/lib/video/candidate-suitability';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
import { providerPortraitInput } from '@/lib/video/provider-portrait';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sourcePng = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#a57755' } })
  .composite([{ input: await sharp({ create: { width: 600, height: 300, channels: 3, background: '#0044ff' } }).png().toBuffer(),
    left: 0, top: 600 }]).png().toBuffer();
const source = await sharp(sourcePng).jpeg({ quality: 60 }).toBuffer();
const crop = { version: 2 as const, status: 'EDGE_CROP' as const, edge: 'BOTTOM' as const, removePermille: 350, overlayDepthPermille: 340 };
const assessment = (overlay: object = { version: 2, status: 'CLEAN' }, extra = {}) => ({ humanPresence: 'CLEAR',
  facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE', blur: 'CLEAR', occlusion: 'NONE_OR_MINOR',
  expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE', observableReason: 'Synthetic fixture only.', sourceOverlay: overlay, ...extra });
const response = (a: object) => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(a) }] }] });
const identity: CandidateAssessmentIdentity = { policy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, model: 'gpt-6-luna',
  sourceVideoMediaId: `media_${'a'.repeat(32)}`, sourceVideoContentHash: 'b'.repeat(64), librarySha256: 'c'.repeat(64),
  preparationSha256: 'd'.repeat(64), representativeFrameId: `video-frame:${'e'.repeat(64)}`, candidateIndex: 66,
  timestampMs: 21333, frameSha256: sha(source), assessmentContract: 'bound-case-portrait-v2' };
beforeEach(() => vi.stubEnv('OPENAI_API_KEY', 'offline-fixture'));
afterEach(() => vi.unstubAllEnvs());
const deps = (request: any, storage = new MemoryPortfolioStorage()) => ({ storage, request, deadlineAtMs: Date.now() + 290_000 });

describe('bound case actual provider PNG assessment', () => {
  async function actualPortrait() {
    const frame = { buffer: sourcePng, frameSha256: sha(sourcePng), byteLength: sourcePng.length, sourceOverlay: crop,
      sourceVideoMediaId: identity.sourceVideoMediaId, sourceVideoContentHash: identity.sourceVideoContentHash,
      timestampMs: identity.timestampMs } as any;
    const [prepared] = await prepareProviderVideoFrames([frame]);
    const selection = { version: 3, libraryId: `video-library:${'f'.repeat(64)}`, librarySha256: identity.librarySha256,
      sourceVideoMediaId: identity.sourceVideoMediaId, sourceVideoContentHash: identity.sourceVideoContentHash,
      candidateBindings: [{ representativeFrameId: identity.representativeFrameId, candidateIndex: identity.candidateIndex,
        timestampMs: identity.timestampMs, frameSha256: identity.frameSha256 }] } as any;
    return { frame, prepared, input: await providerPortraitInput(selection, prepared, identity.model) };
  }
  it('keeps old UNSAFE separate and assesses byte-identical PNG attachment rather than a JPEG derivative', async () => {
    const storage = new MemoryPortfolioStorage(), legacy = { ...identity }; delete legacy.assessmentContract;
    await assessCandidateWithCache(legacy, source, deps(vi.fn(async () => response(assessment({ version: 2, status: 'UNSAFE' }))), storage));
    const feasibility = vi.fn(async () => response(assessment(crop)));
    expect(await assessCandidateWithCache(identity, source, deps(feasibility, storage))).toMatchObject({ status: 'COMPLETE', assessment: { sourceOverlay: crop } });
    expect(feasibility).toHaveBeenCalledOnce();
    const { frame, prepared, input } = await actualPortrait();
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string), image = body.input[1].content[1].image_url;
      expect(image).toMatch(/^data:image\/png;base64,/);
      expect(Buffer.from(image.split(',')[1], 'base64')).toEqual(prepared.providerBuffer);
      expect(body.input[0].content[0].text).toContain('actual retained portrait pixels');
      return response(assessment());
    });
    await assessCandidateWithCache(input.identity, prepared.providerBuffer, deps(request, storage));
    await assessCandidateWithCache(input.identity, prepared.providerBuffer, deps(request, storage)); expect(request).toHaveBeenCalledOnce();
    const [attached] = await prepareProviderVideoFrames([{ ...frame, expectedProviderPngSha256: input.state.providerPngSha256,
      expectedCrop: input.state.crop }]);
    expect(attached.providerBuffer).toEqual(prepared.providerBuffer);
    expect(await sharp(attached.providerBuffer).raw().toBuffer()).toEqual(await sharp(sourcePng)
      .extract({ left: 0, top: 0, width: 600, height: 585 }).raw().toBuffer());
    const wrong = await sharp(sourcePng).negate().png().toBuffer();
    await expect(prepareProviderVideoFrames([{ ...frame, buffer: wrong, frameSha256: sha(wrong), byteLength: wrong.length,
      expectedProviderPngSha256: input.state.providerPngSha256, expectedCrop: input.state.crop }])).rejects.toThrow('pixels changed');
    expect([...storage.data.values()].map(v => JSON.parse(v.bytes.toString()).identity.assessmentContract))
      .toEqual(expect.arrayContaining([undefined, 'head-and-shoulders-v1', 'bound-case-portrait-v2', 'clean-provider-portrait-v1']));
  });
  it('includes exact source PNG and crop in cache identity, and refuses too-small actual attachments', async () => {
    const { prepared, input } = await actualPortrait();
    expect(input.identity).toMatchObject({ frameSha256: prepared.providerPngSha256, sourcePngSha256: sha(sourcePng), sourceCrop: prepared.crop });
    const small = await sharp(sourcePng).resize(100, 100).png().toBuffer();
    await expect(providerPortraitInput({ version: 3, candidateBindings: [{ timestampMs: identity.timestampMs }],
      sourceVideoMediaId: identity.sourceVideoMediaId, sourceVideoContentHash: identity.sourceVideoContentHash } as any,
      { ...prepared, providerBuffer: small, providerPngSha256: sha(small) }, identity.model)).rejects.toThrow('insufficient resolution');
  });
  it('rejects inadequate crop feasibility resolution without additional calls', async () => {
    const small = await sharp(source).resize(200, 300).jpeg().toBuffer(), request = vi.fn(async () => response(assessment(crop)));
    expect(await assessCandidateWithCache({ ...identity, frameSha256: sha(small) }, small, deps(request)))
      .toMatchObject({ status: 'COMPLETE', assessment: { sourceOverlay: { status: 'UNSAFE' } } });
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not replay successful feasibility or uncertain actual PNG assessment automatically', async () => {
    const storage = new MemoryPortfolioStorage(), { prepared, input } = await actualPortrait();
    const request = vi.fn().mockRejectedValueOnce(new Error('uncertain response'));
    expect(await assessCandidateWithCache(input.identity, prepared.providerBuffer, deps(request, storage))).toMatchObject({ status: 'RETRY_REQUIRED' });
    await assessCandidateWithCache(input.identity, prepared.providerBuffer, deps(request, storage)); expect(request).toHaveBeenCalledOnce();
    request.mockResolvedValue(response(assessment()));
    expect(await assessCandidateWithCache(input.identity, prepared.providerBuffer, { ...deps(request, storage), retry: true })).toMatchObject({ status: 'COMPLETE' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
