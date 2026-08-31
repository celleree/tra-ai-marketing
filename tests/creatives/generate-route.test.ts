import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutBlueprint } from '@/lib/layouts/blueprint';
import type { StoredCreativeSourceMediaFile } from '@/lib/media/types';
import { REAL_ENCODED_MP4 } from '@/tests/fixtures/media';

const mocks = vi.hoisted(() => ({
  analyzeTraSourceCreative: vi.fn(),
  generateApprovedTraReferenceCreativeImage: vi.fn(),
  generateCreativeCopy: vi.fn(),
  analyzeApprovedTraVideoFrames: vi.fn(),
  generateApprovedTraVideoFrameCreativeImage: vi.fn(),
  getApprovedTraVideoFrames: vi.fn(),
  getMediaStorage: vi.fn(),
  getOrAnalyzeLayoutBlueprint: vi.fn(),
  listReferenceLibrary: vi.fn(),
  selectBestReferenceCreatives: vi.fn(),
}));

vi.mock('@/lib/ai/openai', () => ({
  analyzeTraSourceCreative: mocks.analyzeTraSourceCreative,
  generateApprovedTraReferenceCreativeImage:
    mocks.generateApprovedTraReferenceCreativeImage,
  generateCreativeCopy: mocks.generateCreativeCopy,
}));

vi.mock('@/lib/ai/video-frame-generation', () => ({
  analyzeApprovedTraVideoFrames: mocks.analyzeApprovedTraVideoFrames,
  generateApprovedTraVideoFrameCreativeImage:
    mocks.generateApprovedTraVideoFrameCreativeImage,
}));

vi.mock('@/lib/video/tra-video-frames', () => ({
  getApprovedTraVideoFrames: mocks.getApprovedTraVideoFrames,
}));

vi.mock('@/lib/ai/reference-selector', () => ({
  selectBestReferenceCreatives: mocks.selectBestReferenceCreatives,
}));

vi.mock('@/lib/layouts/service', () => ({
  getOrAnalyzeLayoutBlueprint: mocks.getOrAnalyzeLayoutBlueprint,
}));

vi.mock('@/lib/media/local-storage', () => ({
  getMediaStorage: mocks.getMediaStorage,
}));

vi.mock('@/lib/references/storage', () => ({
  listReferenceLibrary: mocks.listReferenceLibrary,
}));

import { POST } from '@/app/api/creatives/generate/route';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4 = Buffer.from(REAL_ENCODED_MP4);

const mediaId = (hex: string) => `media_${hex.repeat(32)}`;

const image = (hex: string): StoredCreativeSourceMediaFile => ({
  fileName: `${mediaId(hex)}.png`,
  buffer: Buffer.from(PNG),
  mimeType: 'image/png',
  mediaType: 'IMAGE',
});

const video = (hex: string): StoredCreativeSourceMediaFile => ({
  fileName: `${mediaId(hex)}.mp4`,
  buffer: Buffer.from(MP4),
  mimeType: 'video/mp4',
  mediaType: 'VIDEO',
});

const analysis = {
  summary: 'Source summary',
  visibleText: [],
  visualStructure: 'Simple hierarchy',
  hookOrAngle: 'Tax relief',
  offerOrCta: 'Learn more',
  styleNotes: 'Clear and direct',
  preserve: ['TRA identity'],
  avoid: ['unsupported claims'],
  unknowns: [],
  dominantCategory: 'customer-problems' as const,
};

const layoutBlueprint: LayoutBlueprint = {
  version: 1,
  composition: {
    flow: 'TEXT_LEFT_VISUAL_RIGHT',
    balance: 'ASYMMETRIC',
    imageTextBalance: 'BALANCED',
  },
  regions: [
    {
      role: 'HEADLINE',
      xPct: 8,
      yPct: 18,
      widthPct: 44,
      heightPct: 26,
      alignment: 'LEFT',
      emphasis: 'PRIMARY',
      crop: 'NONE',
      overlapsOtherRegions: false,
    },
    {
      role: 'HUMAN_PLACEHOLDER',
      xPct: 56,
      yPct: 10,
      widthPct: 42,
      heightPct: 76,
      alignment: 'CENTER',
      emphasis: 'HIGH',
      crop: 'WAIST_UP',
      overlapsOtherRegions: false,
    },
  ],
  whitespace: 'MODERATE',
  textDensity: 'SPARSE',
  ctaTreatment: 'ROUNDED_RECTANGLE',
  backgroundMechanisms: ['ASYMMETRIC_COLOR_BLOCK'],
  imageTreatments: ['CUTOUT'],
  typography: {
    headlineScale: 'EXTRA_LARGE',
    headlineWeight: 'BOLD',
    headlineAlignment: 'LEFT',
    hierarchyLevels: 2,
    contrast: 'HIGH',
  },
  spacing: {
    outerMargin: 'GENEROUS',
    regionGap: 'MODERATE',
    alignmentGrid: 'LEFT_EDGE',
  },
  reusableMechanisms: ['ASYMMETRIC_SHAPE_DIVIDER'],
  restrictedElementsPresent: {
    humanIdentity: true,
    thirdPartyLogoOrBranding: true,
    exactCopy: true,
    trademark: false,
    claimOrProof: true,
  },
};

const layoutResolution = {
  blueprint: layoutBlueprint,
  contentHash: 'layout-content-hash',
  analyzerModel: 'gpt-5.6-terra',
  cacheHit: false,
};

const libraryItem = (hex: string) => ({
  id: mediaId(hex),
  fileName: `${mediaId(hex)}.png`,
  originalName: `reference-${hex}.png`,
  mimeType: 'image/png' as const,
  size: PNG.length,
  url: `/api/media/files/${mediaId(hex)}.png`,
  addedAt: '2026-01-01T00:00:00.000Z',
  referenceType: 'layout' as const,
  angle: 'customer-problems' as const,
  angleSource: 'manual' as const,
});

const generationRequest = (
  sourceAssets: Array<{ mediaId: string; role: string }>,
  companyProfile?: object,
  variationCount = 2
) =>
  new Request('http://localhost/api/creatives/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceAssets,
      ...(companyProfile ? { companyProfile } : {}),
      context: 'Create compliant TRA concepts.',
      variationCount,
    }),
  });

const readStreamEvents = async (response: Response) => {
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const body = await response.text();
  return body
    .trim()
    .split('\n\n')
    .map((message) => {
      const [eventLine, dataLine] = message.split('\n');
      return {
        event: eventLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')) as Record<string, unknown>,
      };
    });
};

let storedById: Record<string, StoredCreativeSourceMediaFile>;
let readMediaById: ReturnType<typeof vi.fn>;
let saveImage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  storedById = {};
  readMediaById = vi.fn(async (id: string) => storedById[id] || null);
  saveImage = vi.fn(async (_file: File) => {
    const id = mediaId(String(saveImage.mock.calls.length));
    return {
      id,
      fileName: `${id}.png`,
      originalName: 'generated.png',
      mimeType: 'image/png' as const,
      size: PNG.length,
      url: `/api/media/files/${id}.png`,
    };
  });
  mocks.getMediaStorage.mockReturnValue({
    readMediaById,
    readImageById: vi.fn(async () => null),
    saveImage,
  });
  mocks.getOrAnalyzeLayoutBlueprint.mockResolvedValue(layoutResolution);
  mocks.analyzeTraSourceCreative.mockResolvedValue(analysis);
  mocks.analyzeApprovedTraVideoFrames.mockResolvedValue(analysis);
  mocks.generateCreativeCopy.mockImplementation(async (plan: Array<{ index: number }>) =>
    new Map(
      plan.map((item) => [
        item.index,
        {
          headline: `Headline ${item.index}`,
          primaryText: `Primary ${item.index}`,
          description: `Description ${item.index}`,
        },
      ])
    )
  );
  mocks.generateApprovedTraReferenceCreativeImage.mockResolvedValue(PNG);
  mocks.generateApprovedTraVideoFrameCreativeImage.mockResolvedValue(PNG);
  mocks.getApprovedTraVideoFrames.mockImplementation(async (source) => ({
    source,
    sourceVideoContentHash: 'a'.repeat(64),
    durationMs: 1_000,
    reused: false,
    frames: [
      {
        frameIndex: 0,
        timestampMs: 0,
        mimeType: 'image/png',
        buffer: PNG,
        sourceRole: 'TRA_VIDEO',
        sourceVideoMediaId: source.media.id,
        sourceVideoFileName: source.media.fileName,
        sourceVideoContentHash: 'a'.repeat(64),
        approvedHumanSource: true,
        cacheKey: `derived/video-frames/${source.media.id}/${'a'.repeat(64)}/frame-000.png`,
      },
    ],
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('layout blueprint and final image-provider boundaries', () => {
  it('reduces a layout reference to a blueprint, keeps its pixels analysis-only, and grounds Sol planning', async () => {
    const layoutId = mediaId('a');
    storedById[layoutId] = image('a');

    const response = await POST(
      generationRequest([{ mediaId: layoutId, role: 'LAYOUT_REFERENCE' }], {
        knowledgeBase: { companySummary: 'Runtime approved TRA summary.' },
        guardrails: { approvedClaims: 'Runtime approved claim.' },
      })
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.getOrAnalyzeLayoutBlueprint).toHaveBeenCalledWith(storedById[layoutId]);
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      event: 'complete',
      data: { requestedCount: 2, successfulCount: 2, failedCount: 0 },
    });
    expect(mocks.generateCreativeCopy.mock.calls[0][1]).toContain('APPROVED TRA COMPANY CONTEXT');
    expect(mocks.generateCreativeCopy.mock.calls[0][1]).toContain('Runtime approved TRA summary.');
    expect(mocks.generateCreativeCopy.mock.calls[0][1]).toContain('Runtime approved claim.');
    expect(mocks.generateCreativeCopy.mock.calls[0][1]).toContain('STRUCTURED LAYOUT BLUEPRINT');
    expect(mocks.generateApprovedTraReferenceCreativeImage).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).not.toHaveBeenCalled();

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      const body = JSON.parse(String(options?.body)) as {
        prompt?: string;
        quality?: string;
      };
      expect(body.quality).toBe('high');
      expect(body.prompt).toContain('APPROVED TRA COMPANY CONTEXT');
      expect(body.prompt).toContain('STRUCTURED LAYOUT BLUEPRINT');
      expect(body.prompt).toContain('replace human placeholder geometry with a non-human');
      expect(String(options?.body)).not.toContain(storedById[layoutId].buffer.toString('base64'));
    }
  });

  it('turns validated TRA video into approved frame pixels while keeping raw video out of the image provider', async () => {
    const videoId = mediaId('b');
    storedById[videoId] = video('b');

    const response = await POST(
      generationRequest([{ mediaId: videoId, role: 'TRA_VIDEO' }])
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.getOrAnalyzeLayoutBlueprint).not.toHaveBeenCalled();
    expect(mocks.getApprovedTraVideoFrames).toHaveBeenCalledTimes(1);
    expect(mocks.analyzeApprovedTraVideoFrames).toHaveBeenCalledTimes(1);
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).toHaveBeenCalledTimes(2);
    expect(mocks.generateApprovedTraReferenceCreativeImage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(2);
  });

  it('uses layout planning while supplying only approved extracted TRA video frames to final generation', async () => {
    const layoutId = mediaId('7');
    const videoId = mediaId('8');
    storedById = {
      [layoutId]: image('7'),
      [videoId]: video('8'),
    };

    const response = await POST(
      generationRequest(
        [
          { mediaId: videoId, role: 'TRA_VIDEO' },
          { mediaId: layoutId, role: 'LAYOUT_REFERENCE' },
        ],
        { knowledgeBase: { companySummary: 'Runtime TRA layout-plus-video context.' } }
      )
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.getOrAnalyzeLayoutBlueprint).toHaveBeenCalledWith(storedById[layoutId]);
    expect(mocks.getApprovedTraVideoFrames).toHaveBeenCalledTimes(1);
    expect(mocks.getApprovedTraVideoFrames.mock.calls[0][0].stored).toBe(storedById[videoId]);
    expect(mocks.analyzeApprovedTraVideoFrames).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraReferenceCreativeImage).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).toHaveBeenCalledTimes(2);
    for (const [call] of mocks.generateApprovedTraVideoFrameCreativeImage.mock.calls) {
      expect(call.frames[0].sourceVideoMediaId).toBe(videoId);
      expect(call.context).toContain('APPROVED TRA COMPANY CONTEXT');
      expect(call.context).toContain('Runtime TRA layout-plus-video context.');
      expect(call.context).toContain('STRUCTURED LAYOUT BLUEPRINT');
      expect(call.context).toContain('Layout-reference mode');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(2);
  });

  it('uses layout geometry for planning while attaching only the validated TRA reference from mixed sources', async () => {
    const layoutId = mediaId('c');
    const videoId = mediaId('d');
    const traId = mediaId('e');
    storedById = {
      [layoutId]: image('c'),
      [videoId]: video('d'),
      [traId]: image('e'),
    };

    const response = await POST(
      generationRequest(
        [
          { mediaId: traId, role: 'TRA_REFERENCE' },
          { mediaId: videoId, role: 'TRA_VIDEO' },
          { mediaId: layoutId, role: 'LAYOUT_REFERENCE' },
        ],
        { brandGuidelines: { voiceTone: 'Runtime calm and direct.' } }
      )
    );

    expect(response.status).toBe(200);
    expect(readMediaById).toHaveBeenCalledTimes(3);
    expect(mocks.getApprovedTraVideoFrames).not.toHaveBeenCalled();
    expect(mocks.getOrAnalyzeLayoutBlueprint).toHaveBeenCalledWith(storedById[layoutId]);
    expect(mocks.analyzeTraSourceCreative).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraReferenceCreativeImage).toHaveBeenCalledTimes(2);
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).not.toHaveBeenCalled();
    for (const [call] of mocks.generateApprovedTraReferenceCreativeImage.mock.calls) {
      expect(call.source).toBe(storedById[traId]);
      expect(call.source).not.toBe(storedById[layoutId]);
      expect(call.source.mediaType).toBe('IMAGE');
      expect(call.context).toContain('APPROVED TRA COMPANY CONTEXT');
      expect(call.context).toContain('Runtime calm and direct.');
      expect(call.context).toContain('STRUCTURED LAYOUT BLUEPRINT');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses external library references only as selection metadata', async () => {
    const traId = mediaId('f');
    const firstReference = libraryItem('1');
    const secondReference = libraryItem('2');
    storedById[traId] = image('f');
    mocks.listReferenceLibrary.mockResolvedValue([
      firstReference,
      secondReference,
    ]);
    mocks.selectBestReferenceCreatives.mockResolvedValue([
      {
        item: firstReference,
        imageUrl: `http://localhost${firstReference.url}`,
        selectionReason: 'Strong hierarchy',
      },
      {
        item: secondReference,
        imageUrl: `http://localhost${secondReference.url}`,
        selectionReason: 'Useful contrast',
      },
    ]);

    const response = await POST(
      generationRequest([{ mediaId: traId, role: 'TRA_REFERENCE' }])
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(readMediaById).toHaveBeenCalledTimes(1);
    expect(readMediaById).toHaveBeenCalledWith(traId);
    expect(mocks.getOrAnalyzeLayoutBlueprint).not.toHaveBeenCalled();
    expect(mocks.getApprovedTraVideoFrames).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraReferenceCreativeImage).toHaveBeenCalledTimes(2);
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).not.toHaveBeenCalled();
    expect(
      mocks.generateApprovedTraReferenceCreativeImage.mock.calls.every(
        ([call]) => call.source === storedById[traId]
      )
    ).toBe(true);
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(2);
  });
});

describe('progressive creative delivery', () => {
  it('keeps no-source image rendering capped at two concurrent requests', async () => {
    let active = 0;
    let maximumActive = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return new Response(
          JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const response = await POST(generationRequest([], undefined, 4));
    const events = await readStreamEvents(response);

    expect(maximumActive).toBe(2);
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({
      event: 'complete',
      data: {
        requestedCount: 4,
        successfulCount: 4,
        failedCount: 0,
        successfulIndexes: [1, 2, 3, 4],
      },
    });
    for (const [, options] of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      expect(JSON.parse(String(options?.body)).quality).toBe('high');
    }
  });

  it('emits an indexed render error and continues later creatives', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) return new Response('provider unavailable', { status: 503 });
        return new Response(
          JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const response = await POST(generationRequest([], undefined, 3));
    const events = await readStreamEvents(response);

    expect(events).toContainEqual({
      event: 'error',
      data: { index: 1, error: 'Creative 1 could not be generated.' },
    });
    expect(
      events
        .filter(({ event }) => event === 'creative')
        .map(({ data }) => (data.creative as { index: number }).index)
        .sort()
    ).toEqual([2, 3]);
    expect(events.at(-1)).toMatchObject({
      event: 'complete',
      data: {
        requestedCount: 3,
        successfulCount: 2,
        failedCount: 1,
        successfulIndexes: [2, 3],
        failedIndexes: [1],
      },
    });
  });

  it('keeps early invalid requests as JSON errors', async () => {
    const response = await POST(
      new Request('http://localhost/api/creatives/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: '', variationCount: 2 }),
      })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ error: 'context is required' });
  });
});
