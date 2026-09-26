import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeApprovedTraVideoFrames,
  generateApprovedTraVideoFrameCreativeImage,
  selectProviderVideoFrames,
} from '@/lib/ai/video-frame-generation';
import { getVideoFrameIntegrity } from '@/lib/video/frame-cache';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';
import { resolveCreativeLogoGeometry } from '@/lib/creatives/logo-placement';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const MEDIA_ID = `media_${'d'.repeat(32)}`;
const HASH = 'e'.repeat(64);
const makeFrames = (count = 6): ApprovedTraVideoFrame[] => Array.from({ length: count }, (_, index) => ({
  frameIndex: index,
  timestampMs: index * 1_000,
  mimeType: 'image/png',
  buffer: PNG,
  ...getVideoFrameIntegrity(PNG),
  sourceRole: 'TRA_VIDEO',
  sourceVideoMediaId: MEDIA_ID,
  sourceVideoFileName: `${MEDIA_ID}.mp4`,
  sourceVideoContentHash: HASH,
  approvedHumanSource: true,
  cacheKey: `derived/video-frames/${MEDIA_ID}/${HASH}/frame-${String(index).padStart(3, '0')}.png`,
  sourceOverlay: { version: 2, status: 'CLEAN' },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('approved TRA video-frame provider boundary', () => {
  it.each(['completed', 'incomplete', 'failed'])('bounds analysis and accepts only a completed response: %s', async (status) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const result = { summary: 'Synthetic source', visibleText: [], visualStructure: 'Color bars', hookOrAngle: '', offerOrCta: '', styleNotes: '', preserve: [], avoid: [], unknowns: [], dominantCategory: 'educational' };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status, output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = analyzeApprovedTraVideoFrames({ frames: makeFrames(1), context: 'Approved company context' });
    if (status === 'completed') await expect(pending).resolves.toEqual(result);
    else await expect(pending).rejects.toThrow('did not complete');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_output_tokens).toBe(8192);
  });

  it('bounds provider pixels to representative first/middle/last frames', () => {
    expect(selectProviderVideoFrames(makeFrames()).map((frame) => frame.frameIndex)).toEqual([0, 2, 5]);
  });

  it('adds a selected document after the approved frames without changing human provenance', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ b64_json: PNG.toString('base64') }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateApprovedTraVideoFrameCreativeImage({
      frames: makeFrames(1), primaryFormat: 'direct-response', context: 'A notice on a desk',
      copy: { headline: 'Talk with TRA' }, taxDocumentReference: 'irs-notice-v1',
    });
    const images = (fetchMock.mock.calls[0][1].body as FormData).getAll('image[]') as File[];
    expect(images.map(file => file.type)).toEqual(['image/png', 'image/jpeg']);
    expect(result.providerFrames).toMatchObject(makeFrames(1));
    expect(result.prompt).toContain('NOT a TRA human source');
  });

  it.each([false, true])('sends approved PNG pixels and preserves invisible logo reservation when enabled: %s', async (reserveLogoArea) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateApprovedTraVideoFrameCreativeImage({
      frames: makeFrames(),
      primaryFormat: 'direct-response',
      context: 'Approved company context',
      ...(reserveLogoArea ? { logoGeometry: resolveCreativeLogoGeometry('SQUARE_1_1', 'bottom-right', 200, 100) } : {}),
      copy: { headline: 'Get clear next steps', shortSupport: 'Talk with TRA.', cta: 'Learn more' },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/images/edits');
    const formData = init.body as FormData;
    expect(formData.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(formData.get('quality')).toBe('high');
    expect(formData.getAll('image[]')).toHaveLength(3);
    expect(formData.getAll('image[]').every((image) => image instanceof Blob && image.type === 'image/png')).toBe(true);
    expect(formData.get('prompt')).toContain('Raw video is NOT attached');
    expect(formData.get('prompt')).toContain('No layout-reference pixels');
    expect(formData.get('prompt')).toContain(MEDIA_ID);
    expect(formData.get('prompt')).not.toContain('Primary text:');
    expect(formData.get('prompt')).not.toContain('Description:');
    if (reserveLogoArea) {
      expect(formData.get('prompt')).toContain('invisible composition constraint');
      expect(formData.get('prompt')).toContain('do not render a placeholder, box, panel, border, dashed outline');
      expect(formData.get('prompt')).toContain('Continue the surrounding background naturally');
    } else {
      expect(formData.get('prompt')).not.toContain('invisible composition constraint');
    }
    expect(result.prompt).toBe(formData.get('prompt'));
    expect(result.model).toBe(formData.get('model'));
    expect(result.providerFrames.map((frame) => frame.frameIndex)).toEqual([0, 2, 5]);
  });

  it('rejects forged non-TRA frame provenance before any provider call', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const frames = makeFrames(1);
    frames[0] = { ...frames[0], sourceRole: 'LAYOUT_REFERENCE' as 'TRA_VIDEO' };
    await expect(generateApprovedTraVideoFrameCreativeImage({ frames, primaryFormat: 'direct-response', context: 'context', copy: { headline: 'h' } })).rejects.toThrow('Refusing non-TRA or invalid pixels');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a frame whose bytes no longer match its approved integrity provenance', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const frames = makeFrames(1);
    frames[0] = { ...frames[0], buffer: Buffer.from(PNG.subarray(0, 16)) };
    await expect(generateApprovedTraVideoFrameCreativeImage({ frames, primaryFormat: 'direct-response', context: 'context', copy: { headline: 'h' } })).rejects.toThrow('Refusing non-TRA or invalid pixels');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
