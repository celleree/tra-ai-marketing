import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateApprovedTraVideoFrameCreativeImage,
  selectProviderVideoFrames,
} from '@/lib/ai/video-frame-generation';
import { getVideoFrameIntegrity } from '@/lib/video/frame-cache';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

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
}));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('approved TRA video-frame provider boundary', () => {
  it('bounds provider pixels to representative first/middle/last frames', () => {
    expect(selectProviderVideoFrames(makeFrames()).map((frame) => frame.frameIndex)).toEqual([0, 2, 5]);
  });

  it('sends only content-bound approved PNG frame pixels to image editing and never raw MP4 pixels', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await generateApprovedTraVideoFrameCreativeImage({
      frames: makeFrames(),
      primaryFormat: 'direct-response',
      context: 'Approved company context',
      copy: { headline: 'Get clear next steps', primaryText: 'Talk with TRA.', description: 'No-pressure consultation.' },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/images/edits');
    const formData = init.body as FormData;
    expect(formData.get('quality')).toBe('high');
    expect(formData.getAll('image[]')).toHaveLength(3);
    expect(formData.getAll('image[]').every((image) => image instanceof Blob && image.type === 'image/png')).toBe(true);
    expect(formData.get('prompt')).toContain('Raw video is NOT attached');
    expect(formData.get('prompt')).toContain('No layout-reference pixels');
    expect(formData.get('prompt')).toContain(MEDIA_ID);
  });

  it('rejects forged non-TRA frame provenance before any provider call', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const frames = makeFrames(1);
    frames[0] = { ...frames[0], sourceRole: 'LAYOUT_REFERENCE' as 'TRA_VIDEO' };
    await expect(generateApprovedTraVideoFrameCreativeImage({ frames, primaryFormat: 'direct-response', context: 'context', copy: { headline: 'h', primaryText: 'p', description: 'd' } })).rejects.toThrow('Refusing non-TRA or invalid pixels');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a frame whose bytes no longer match its approved integrity provenance', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const frames = makeFrames(1);
    frames[0] = { ...frames[0], buffer: Buffer.from(PNG.subarray(0, 16)) };
    await expect(generateApprovedTraVideoFrameCreativeImage({ frames, primaryFormat: 'direct-response', context: 'context', copy: { headline: 'h', primaryText: 'p', description: 'd' } })).rejects.toThrow('Refusing non-TRA or invalid pixels');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
