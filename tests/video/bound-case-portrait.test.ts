import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessCandidateWithCache, type CandidateAssessmentIdentity } from '@/lib/video/candidate-suitability';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const source = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#a57755' } })
  .composite([{ input: await sharp({ create: { width: 600, height: 300, channels: 3, background: '#0044ff' } }).png().toBuffer(),
    left: 0, top: 600 }]).jpeg().toBuffer();
const crop = { version: 2 as const, status: 'EDGE_CROP' as const, edge: 'BOTTOM' as const, removePermille: 350, overlayDepthPermille: 340 };
const assessment = (overlay: object = { version: 2, status: 'CLEAN' }, extra = {}) => ({ humanPresence: 'CLEAR',
  facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE', blur: 'CLEAR', occlusion: 'NONE_OR_MINOR',
  expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE', observableReason: 'Synthetic fixture only.', sourceOverlay: overlay, ...extra });
const response = (a: object) => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(a) }] }] });
const identity: CandidateAssessmentIdentity = { policy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, model: 'gpt-6-luna',
  sourceVideoMediaId: `media_${'a'.repeat(32)}`, sourceVideoContentHash: 'b'.repeat(64), librarySha256: 'c'.repeat(64),
  preparationSha256: 'd'.repeat(64), representativeFrameId: `video-frame:${'e'.repeat(64)}`, candidateIndex: 66,
  timestampMs: 21333, frameSha256: sha(source), assessmentContract: 'bound-case-portrait-v1' };
beforeEach(() => vi.stubEnv('OPENAI_API_KEY', 'offline-fixture'));
afterEach(() => vi.unstubAllEnvs());
const deps = (request: any, storage = new MemoryPortfolioStorage()) => ({ storage, request, deadlineAtMs: Date.now() + 290_000 });

describe('bound case retained portrait assessment', () => {
  it('does not reuse whole-frame UNSAFE; assesses actual crop and preserves provider crop pixels', async () => {
    const storage = new MemoryPortfolioStorage();
    const legacy = { ...identity }; delete legacy.assessmentContract;
    await assessCandidateWithCache(legacy, source, deps(vi.fn(async () => response(assessment({ version: 2, status: 'UNSAFE' }))), storage));
    const calls: any[] = [];
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string); calls.push(body);
      if (calls.length === 2) {
        const bytes = Buffer.from(body.input[1].content[1].image_url.split(',')[1], 'base64');
        expect((await sharp(bytes).metadata()).height).toBe(585);
        expect(body.input[0].content[0].text).toContain('actual retained portrait pixels');
      }
      return response(assessment(calls.length === 1 ? crop : { version: 2, status: 'CLEAN' }));
    });
    const state = await assessCandidateWithCache(identity, source, deps(request, storage));
    expect(state).toMatchObject({ status: 'COMPLETE', assessment: { sourceOverlay: crop } });
    await assessCandidateWithCache(identity, source, deps(request, storage)); expect(request).toHaveBeenCalledTimes(2);
    const png = await sharp(source).png().toBuffer();
    const [prepared] = await prepareProviderVideoFrames([{ buffer: png, frameSha256: sha(png), byteLength: png.length,
      sourceOverlay: crop } as any]);
    expect(await sharp(prepared.providerBuffer).raw().toBuffer()).toEqual(await sharp(png)
      .extract({ left: 0, top: 0, width: 600, height: 585 }).raw().toBuffer());
    expect([...storage.data.values()].map(v => JSON.parse(v.bytes.toString()).identity.assessmentContract))
      .toEqual(expect.arrayContaining([undefined, 'head-and-shoulders-v1', 'clean-portrait-v1', 'bound-case-portrait-v1']));
  });
  it.each([{ version: 2, status: 'UNSAFE' }, { version: 2, status: 'CLEAN' }])('rejects retained overlay or closed eyes', async overlay => {
    const request = vi.fn().mockResolvedValueOnce(response(assessment(crop)))
      .mockResolvedValueOnce(response(assessment(overlay, { eyes: 'CLOSED_OR_BLINKING' })));
    expect(await assessCandidateWithCache(identity, source, deps(request))).toMatchObject({ status: 'COMPLETE',
      assessment: { sourceOverlay: { status: 'UNSAFE' } } });
  });
  it('rejects inadequate retained resolution without a second call', async () => {
    const small = await sharp(source).resize(200, 300).jpeg().toBuffer(), request = vi.fn(async () => response(assessment(crop)));
    expect(await assessCandidateWithCache({ ...identity, frameSha256: sha(small) }, small, deps(request)))
      .toMatchObject({ status: 'COMPLETE', assessment: { sourceOverlay: { status: 'UNSAFE' } } });
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not replay successful crop feasibility or uncertain retained assessment', async () => {
    const storage = new MemoryPortfolioStorage(), request = vi.fn().mockResolvedValueOnce(response(assessment(crop)))
      .mockRejectedValueOnce(new Error('uncertain response'));
    expect(await assessCandidateWithCache(identity, source, deps(request, storage))).toMatchObject({ status: 'RETRY_REQUIRED' });
    await assessCandidateWithCache(identity, source, deps(request, storage)); expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValue(response(assessment()));
    expect(await assessCandidateWithCache(identity, source, { ...deps(request, storage), retry: true })).toMatchObject({ status: 'COMPLETE' });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
