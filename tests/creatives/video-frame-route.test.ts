import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { parseCreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import type { MediaStorage } from '@/lib/media/storage';
import { getVideoFrameIntegrity } from '@/lib/video/frame-cache';
import type { ApprovedTraVideoFrameSet } from '@/lib/video/types';
import { REAL_ENCODED_MP4 } from '@/tests/fixtures/media';

const {
  analyzeApprovedTraVideoFramesMock,
  planCreativeBatchMock,
  generateApprovedTraVideoFrameCreativeImageMock,
  getApprovedTraVideoFramesMock,
  readMediaByIdMock,
  readImageByIdMock,
  saveImageMock,
  saveCreativeBatchMock,
  validateGeneratedCreativeImageMock,
  getOperatorAccessMock,
  requireOperatorQuotaMock,
} = vi.hoisted(() => ({
  analyzeApprovedTraVideoFramesMock: vi.fn(),
  planCreativeBatchMock: vi.fn(),
  generateApprovedTraVideoFrameCreativeImageMock: vi.fn(),
  getApprovedTraVideoFramesMock: vi.fn(),
  readMediaByIdMock: vi.fn(),
  readImageByIdMock: vi.fn(),
  saveImageMock: vi.fn(),
  saveCreativeBatchMock: vi.fn(),
  validateGeneratedCreativeImageMock: vi.fn(),
  getOperatorAccessMock: vi.fn(),
  requireOperatorQuotaMock: vi.fn(),
}));

vi.mock('@/lib/auth/server-access', () => ({
  getOperatorAccess: getOperatorAccessMock,
}));
vi.mock('@/lib/quotas/require-quota', () => ({
  requireOperatorQuota: requireOperatorQuotaMock,
}));

vi.mock('@/lib/creatives/storage', () => ({ saveCreativeBatch: saveCreativeBatchMock }));

vi.mock('@/lib/creatives/generated-image-validation', async (original) => ({
  ...(await original<typeof import('@/lib/creatives/generated-image-validation')>()),
  validateGeneratedCreativeImage: validateGeneratedCreativeImageMock,
}));

vi.mock('@/lib/ai/openai', () => ({
  analyzeReferenceCreative: vi.fn(),
  analyzeTraSourceCreative: vi.fn(),
  generateApprovedTraReferenceCreativeImage: vi.fn(),
}));
vi.mock('@/lib/ai/creative-planner', () => ({
  planCreativeBatch: planCreativeBatchMock,
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const imageResult = {
  buffer: PNG,
  prompt: 'Mock final image prompt',
  model: 'gpt-image-2.5-sunburst',
  routing: { operationType: 'TRA_VIDEO_FRAME_GENERATION' as const, preferredModel: 'gpt-image-2.5-sunburst' as const, actualModel: 'gpt-image-2.5-sunburst' as const, fallbackUsed: false, fallbackFromModel: null, fallbackReason: null },
};
const VIDEO_ID = `media_${'1'.repeat(32)}`;
const HASH = createHash('sha256').update(REAL_ENCODED_MP4).digest('hex');
const analysis = { summary: 'Approved TRA video source.', visibleText: [], visualStructure: 'Talking-head source context.', hookOrAngle: 'clarity', offerOrCta: 'consultation', styleNotes: 'Use identity, not old layout.', preserve: ['visible person identity'], avoid: ['old captions'], unknowns: [], dominantCategory: 'customer-problems' };
const makeFrameSet = (source: unknown): ApprovedTraVideoFrameSet => ({
  source: source as ApprovedTraVideoFrameSet['source'], sourceVideoContentHash: HASH, durationMs: 10_000, reused: false,
  frames: [{ frameIndex: 0, timestampMs: 0, mimeType: 'image/png', buffer: PNG, ...getVideoFrameIntegrity(PNG), sourceRole: 'TRA_VIDEO', sourceVideoMediaId: VIDEO_ID, sourceVideoFileName: `${VIDEO_ID}.mp4`, sourceVideoContentHash: HASH, approvedHumanSource: true, cacheKey: `derived/video-frames/${VIDEO_ID}/${HASH}/frame-000.png` }],
});
const makeRequest = () => new Request('https://tra.example/api/creatives/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: 'Create clear TRA ads.', variationCount: 2, sourceAssets: [{ mediaId: VIDEO_ID, role: 'TRA_VIDEO' }] }) });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorAccessMock.mockResolvedValue({ allowed: true, userId: 'operator' });
  requireOperatorQuotaMock.mockResolvedValue(null);
  saveCreativeBatchMock.mockReset().mockImplementation(async (records) => records);
  validateGeneratedCreativeImageMock.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  readMediaByIdMock.mockResolvedValue({ fileName: `${VIDEO_ID}.mp4`, buffer: REAL_ENCODED_MP4, mimeType: 'video/mp4', mediaType: 'VIDEO' });
  readImageByIdMock.mockResolvedValue(null);
  getApprovedTraVideoFramesMock.mockImplementation(async (source) => makeFrameSet(source));
  analyzeApprovedTraVideoFramesMock.mockResolvedValue(analysis);
  const concept = (index: number) => ({
    index,
    format: 'direct-response',
    copy: {
      headline: `Clear next step ${index}`,
      primaryText: 'Talk with TRA.',
      description: 'No-pressure consultation.',
    },
    strategy: {
      category: 'customer-problems',
      awarenessStage: index === 1 ? 'problem-aware' : 'solution-aware',
      persona: 'Taxpayer',
      painPoint: 'Unclear options',
      desiredOutcome: 'Clarity',
      emotion: 'reassured',
      hook: `Option ${index}`,
      cta: 'Talk with TRA',
      offer: null,
      soWhat: {
        surfaceMessage: `Message ${index}`,
        functionalConsequence: `Consequence ${index}`,
        meaningfulOutcome: `Outcome ${index}`,
      },
      execution: {
        subjectSource: 'approved-tra-human',
        composition: index === 1 ? 'single-focus' : 'split',
        imageTreatment: index === 1 ? 'photographic' : 'mixed-media',
        textDensity: 'medium',
        ctaTreatment: 'button',
        typographyHierarchy: 'headline-dominant',
      },
      visualDirection: `Source-bound direction ${index}`,
    },
    selectionReason: `Distinct fit ${index}`,
  });
  planCreativeBatchMock.mockResolvedValue({
    creatives: [concept(1), concept(2)],
    plannerModel: 'gpt-6-astra',
    reasoningEffort: 'medium',
  });
  generateApprovedTraVideoFrameCreativeImageMock.mockImplementation(
    async ({ frames }) => ({ ...imageResult, providerFrames: frames })
  );
  saveImageMock.mockResolvedValue({ id: `media_${'9'.repeat(32)}`, fileName: `media_${'9'.repeat(32)}.png`, originalName: 'generated.png', mimeType: 'image/png', size: PNG.length, url: '/generated.png' });
});
afterEach(() => vi.unstubAllEnvs());

describe('creative generation TRA video integration', () => {
  it('uses extracted approved frames for Sol analysis and final generation through SSE without raw pixels', async () => {
    const response = await POST(makeRequest());
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = (await response.text())
      .trim()
      .split('\n\n')
      .map((message) => {
        const [eventLine, dataLine] = message.split('\n');
        return {
          event: eventLine.replace('event: ', ''),
          data: JSON.parse(dataLine.replace('data: ', '')) as Record<string, unknown>,
        };
      });
    expect(response.status).toBe(200);
    expect(getApprovedTraVideoFramesMock).toHaveBeenCalledTimes(1);
    expect(analyzeApprovedTraVideoFramesMock).toHaveBeenCalledWith(expect.objectContaining({ context: expect.stringContaining('USER CREATIVE DIRECTION') }));
    expect(planCreativeBatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasApprovedHumanSource: true })
    );
    expect(generateApprovedTraVideoFrameCreativeImageMock).toHaveBeenCalledTimes(2);
    expect(validateGeneratedCreativeImageMock).toHaveBeenCalledTimes(2);
    expect(validateGeneratedCreativeImageMock).toHaveBeenCalledWith(PNG, 'SQUARE_1_1');
    expect(
      await Promise.all(
        saveImageMock.mock.calls.map(async ([file]) =>
          Buffer.from(await (file as File).arrayBuffer())
        )
      )
    ).toEqual([PNG, PNG]);
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(2);
    for (const { data } of events.filter(({ event }) => event === 'creative')) {
      const provenance = parseCreativeGenerationProvenance(
        (data.creative as { generationProvenance?: unknown }).generationProvenance
      );
      expect(provenance).toMatchObject({
        imageGeneration: { prompt: imageResult.prompt, model: imageResult.model, routing: imageResult.routing },
        requestedSources: [
          { role: 'TRA_VIDEO', mediaId: VIDEO_ID, sha256: HASH },
        ],
        attachedSource: {
          type: 'TRA_VIDEO_FRAMES',
          mediaId: VIDEO_ID,
          sourceSha256: HASH,
          selectionMode: 'AUTOMATIC',
          frames: [
            {
              timestampMs: 0,
              approvedPngSha256: getVideoFrameIntegrity(PNG).frameSha256,
            },
          ],
        },
      });
    }
    expect(events.at(-1)).toMatchObject({
      event: 'complete',
      data: { requestedCount: 2, successfulCount: 2, failedCount: 0 },
    });
    expect(JSON.stringify(events)).not.toContain('buffer');
  });

  it('returns 400 for corrupt/unsupported video before Sol or image generation', async () => {
    getApprovedTraVideoFramesMock.mockRejectedValue(new TraVideoProcessingError('The TRA video could not be decoded. Upload a supported, non-corrupt MP4 video.'));
    const response = await POST(makeRequest());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('could not be decoded');
    expect(analyzeApprovedTraVideoFramesMock).not.toHaveBeenCalled();
    expect(planCreativeBatchMock).not.toHaveBeenCalled();
    expect(generateApprovedTraVideoFrameCreativeImageMock).not.toHaveBeenCalled();
  });
});
