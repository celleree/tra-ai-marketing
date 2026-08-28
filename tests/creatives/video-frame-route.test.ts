import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaStorage } from '@/lib/media/storage';
import type { ApprovedTraVideoFrameSet } from '@/lib/video/types';
import { REAL_ENCODED_MP4 } from '@/tests/fixtures/media';

const {
  analyzeApprovedTraVideoFramesMock,
  generateCreativeCopyMock,
  generateApprovedTraVideoFrameCreativeImageMock,
  getApprovedTraVideoFramesMock,
  readMediaByIdMock,
  readImageByIdMock,
  saveImageMock,
} = vi.hoisted(() => ({
  analyzeApprovedTraVideoFramesMock: vi.fn(),
  generateCreativeCopyMock: vi.fn(),
  generateApprovedTraVideoFrameCreativeImageMock: vi.fn(),
  getApprovedTraVideoFramesMock: vi.fn(),
  readMediaByIdMock: vi.fn(),
  readImageByIdMock: vi.fn(),
  saveImageMock: vi.fn(),
}));

vi.mock('@/lib/ai/openai', () => ({
  analyzeReferenceCreative: vi.fn(),
  analyzeTraSourceCreative: vi.fn(),
  generateCreativeCopy: generateCreativeCopyMock,
  generateApprovedTraReferenceCreativeImage: vi.fn(),
}));
vi.mock('@/lib/ai/video-frame-generation', () => ({
  analyzeApprovedTraVideoFrames: analyzeApprovedTraVideoFramesMock,
  generateApprovedTraVideoFrameCreativeImage: generateApprovedTraVideoFrameCreativeImageMock,
}));
vi.mock('@/lib/video/tra-video-frames', () => ({ getApprovedTraVideoFrames: getApprovedTraVideoFramesMock }));
vi.mock('@/lib/ai/reference-selector', () => ({ selectBestReferenceCreatives: vi.fn() }));
vi.mock('@/lib/references/storage', () => ({ listReferenceLibrary: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/media/local-storage', () => ({
  getMediaStorage: () => ({ readMediaById: readMediaByIdMock, readImageById: readImageByIdMock, saveImage: saveImageMock }) as unknown as MediaStorage,
}));

import { POST } from '@/app/api/creatives/generate/route';
import { TraVideoProcessingError } from '@/lib/video/ffmpeg';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VIDEO_ID = `media_${'1'.repeat(32)}`;
const HASH = '3'.repeat(64);
const analysis = { summary: 'Approved TRA video source.', visibleText: [], visualStructure: 'Talking-head source context.', hookOrAngle: 'clarity', offerOrCta: 'consultation', styleNotes: 'Use identity, not old layout.', preserve: ['visible person identity'], avoid: ['old captions'], unknowns: [], dominantCategory: 'customer-problems' };
const makeFrameSet = (source: unknown): ApprovedTraVideoFrameSet => ({
  source: source as ApprovedTraVideoFrameSet['source'], sourceVideoContentHash: HASH, durationMs: 10_000, reused: false,
  frames: [{ frameIndex: 0, timestampMs: 0, mimeType: 'image/png', buffer: PNG, sourceRole: 'TRA_VIDEO', sourceVideoMediaId: VIDEO_ID, sourceVideoFileName: `${VIDEO_ID}.mp4`, sourceVideoContentHash: HASH, approvedHumanSource: true, cacheKey: `derived/video-frames/${VIDEO_ID}/${HASH}/frame-000.png` }],
});
const makeRequest = () => new Request('https://tra.example/api/creatives/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: 'Create clear TRA ads.', variationCount: 2, sourceAssets: [{ mediaId: VIDEO_ID, role: 'TRA_VIDEO' }] }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  readMediaByIdMock.mockResolvedValue({ fileName: `${VIDEO_ID}.mp4`, buffer: REAL_ENCODED_MP4, mimeType: 'video/mp4', mediaType: 'VIDEO' });
  readImageByIdMock.mockResolvedValue(null);
  getApprovedTraVideoFramesMock.mockImplementation(async (source) => makeFrameSet(source));
  analyzeApprovedTraVideoFramesMock.mockResolvedValue(analysis);
  generateCreativeCopyMock.mockResolvedValue(new Map([
    [1, { headline: 'Clear next steps', primaryText: 'Talk with TRA.', description: 'No-pressure consultation.' }],
    [2, { headline: 'Understand options', primaryText: 'Get a clearer path.', description: 'Talk with TRA.' }],
  ]));
  generateApprovedTraVideoFrameCreativeImageMock.mockResolvedValue(PNG);
  saveImageMock.mockResolvedValue({ id: `media_${'9'.repeat(32)}`, fileName: `media_${'9'.repeat(32)}.png`, originalName: 'generated.png', mimeType: 'image/png', size: PNG.length, url: '/generated.png' });
});
afterEach(() => vi.unstubAllEnvs());

describe('creative generation TRA video integration', () => {
  it('uses extracted approved frames for Sol analysis and final generation and returns provenance without raw pixels', async () => {
    const response = await POST(makeRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(getApprovedTraVideoFramesMock).toHaveBeenCalledTimes(1);
    expect(analyzeApprovedTraVideoFramesMock).toHaveBeenCalledWith(expect.objectContaining({ context: expect.stringContaining('USER CREATIVE DIRECTION') }));
    expect(generateApprovedTraVideoFrameCreativeImageMock).toHaveBeenCalledTimes(2);
    expect(body.generationSourceRole).toBe('TRA_VIDEO');
    expect(body.providerSourceRole).toBe('TRA_VIDEO');
    expect(body.approvedVideoFrames).toMatchObject({ sourceVideoMediaId: VIDEO_ID, sourceVideoContentHash: HASH, durationMs: 10_000, reused: false, frames: [{ frameIndex: 0, timestampMs: 0, sourceRole: 'TRA_VIDEO', approvedHumanSource: true }] });
    expect(JSON.stringify(body.approvedVideoFrames)).not.toContain('buffer');
  });

  it('returns 400 for corrupt/unsupported video before Sol or image generation', async () => {
    getApprovedTraVideoFramesMock.mockRejectedValue(new TraVideoProcessingError('The TRA video could not be decoded. Upload a supported, non-corrupt MP4 video.'));
    const response = await POST(makeRequest());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('could not be decoded');
    expect(analyzeApprovedTraVideoFramesMock).not.toHaveBeenCalled();
    expect(generateCreativeCopyMock).not.toHaveBeenCalled();
    expect(generateApprovedTraVideoFrameCreativeImageMock).not.toHaveBeenCalled();
  });
});
