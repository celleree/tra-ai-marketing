import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { prepareCreativeGeneration } from '@/lib/creatives/prepare-generation';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { parseCreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { parseCreativeIdentity } from '@/lib/creatives/identity';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';
import { TAX_DOCUMENT_REFERENCES } from '@/lib/references/tax-documents';
import { resolveReferenceSelection, type ReferencePlanningCandidate } from '@/lib/references/planning';
import { GeneratedImageValidationError } from '@/lib/creatives/generated-image-validation';
import type { LayoutBlueprint } from '@/lib/layouts/blueprint';
import type { StoredCreativeSourceMediaFile } from '@/lib/media/types';
import { REAL_ENCODED_MP4 } from '@/tests/fixtures/media';
import { portfolioAudit } from '../fixtures/portfolio-audit';

const mocks = vi.hoisted(() => ({
  humanOptions: vi.fn(),
  resolveHuman: vi.fn(),
  compositeCreativeBrandLogo: vi.fn(),
  saveCreativeBatch: vi.fn(),
  validateGeneratedCreativeImage: vi.fn(),
  analyzeTraSourceCreative: vi.fn(),
  analyzeReferenceCreative: vi.fn(),
  generateApprovedTraReferenceCreativeImage: vi.fn(),
  planCreativeBatch: vi.fn(),
  analyzeApprovedTraVideoFrames: vi.fn(),
  generateApprovedTraVideoFrameCreativeImage: vi.fn(),
  getApprovedTraVideoFrames: vi.fn(),
  extractVideoSelectionFrames: vi.fn(),
  loadVideoSelectionContext: vi.fn(),
  getMediaStorage: vi.fn(),
  getOrAnalyzeLayoutBlueprint: vi.fn(),
  listReferenceLibrary: vi.fn(),
  selectBestReferenceCreatives: vi.fn(),
  getOperatorAccess: vi.fn(),
  requireOperatorQuota: vi.fn(),
}));
vi.mock('@/lib/video/approved-human-planning', () => ({ loadApprovedHumanOptions: mocks.humanOptions }));
vi.mock('@/lib/video/approved-human-service', () => ({ resolveApprovedHumanFrame: mocks.resolveHuman }));

vi.mock('@/lib/auth/server-access', () => ({
  getOperatorAccess: mocks.getOperatorAccess,
}));
vi.mock('@/lib/quotas/require-quota', () => ({
  requireOperatorQuota: mocks.requireOperatorQuota,
}));

vi.mock('@/lib/creatives/brand-logo.server', () => ({ compositeCreativeBrandLogo: mocks.compositeCreativeBrandLogo }));
vi.mock('@/lib/creatives/storage', () => ({ saveCreativeBatch: mocks.saveCreativeBatch }));

vi.mock('@/lib/creatives/generated-image-validation', async (original) => ({
  ...(await original<typeof import('@/lib/creatives/generated-image-validation')>()),
  validateGeneratedCreativeImage: mocks.validateGeneratedCreativeImage,
}));

vi.mock('@/lib/ai/openai', () => ({
  analyzeReferenceCreative: mocks.analyzeReferenceCreative,
  analyzeTraSourceCreative: mocks.analyzeTraSourceCreative,
  generateApprovedTraReferenceCreativeImage:
    mocks.generateApprovedTraReferenceCreativeImage,
}));

vi.mock('@/lib/ai/creative-planner', () => ({
  planCreativeBatch: mocks.planCreativeBatch,
}));

vi.mock('@/lib/ai/video-frame-generation', () => ({
  analyzeApprovedTraVideoFrames: mocks.analyzeApprovedTraVideoFrames,
  generateApprovedTraVideoFrameCreativeImage:
    mocks.generateApprovedTraVideoFrameCreativeImage,
}));

vi.mock('@/lib/video/tra-video-frames', () => ({
  getApprovedTraVideoFrames: mocks.getApprovedTraVideoFrames,
}));

vi.mock('@/lib/video/selection-context', () => ({
  extractVideoSelectionFrames: mocks.extractVideoSelectionFrames,
  loadVideoSelectionContext: mocks.loadVideoSelectionContext,
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

import {
  generatePromptOnlyCreativeImage,
  POST,
} from '@/app/api/creatives/generate/route';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageResultFor = (operationType: 'PROMPT_GENERATION' | 'TRA_REFERENCE_GENERATION' | 'TRA_VIDEO_FRAME_GENERATION') => ({
  buffer: PNG, prompt: 'Mock final image prompt', model: 'gpt-image-2.5-sunburst',
  routing: { operationType, preferredModel: 'gpt-image-2.5-sunburst' as const, actualModel: 'gpt-image-2.5-sunburst' as const, fallbackUsed: false, fallbackFromModel: null, fallbackReason: null },
});
const imageResult = imageResultFor('PROMPT_GENERATION');
const MP4 = Buffer.from(REAL_ENCODED_MP4);
const LIBRARY_ID = `video-library:${'a'.repeat(64)}`;
const LIBRARY_FRAME_ID = `video-frame:${'b'.repeat(64)}`;

const mediaId = (hex: string) => `media_${hex.repeat(32)}`;
const contentHash = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');
const selectionFor = (sourceVideoContentHash: string) => ({
  libraryId: LIBRARY_ID,
  sourceVideoContentHash,
  frameIds: [LIBRARY_FRAME_ID],
});

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

const awarenessStages = [
  'problem-aware',
  'solution-aware',
  'service-aware',
  'action-ready',
] as const;
const compositions = ['single-focus', 'split', 'stacked', 'grid'] as const;
const imageTreatments = [
  'minimal-graphic',
  'illustrative',
  'mixed-media',
  'photographic',
] as const;
const plannedCreative = (
  index: number,
  subjectSource: 'approved-tra-human' | 'non-human' = 'non-human'
) => ({
  index,
  format: 'direct-response' as const,
  copy: {
    headline: `Headline ${index}`,
    primaryText: `Primary ${index}`,
    description: `Description ${index}`,
  },
  strategy: {
    category: 'customer-problems' as const,
    awarenessStage: awarenessStages[index - 1] || 'action-ready',
    persona: 'Taxpayer seeking clarity',
    painPoint: `Unclear tax options ${index}`,
    desiredOutcome: `A clear next step ${index}`,
    emotion: 'reassured',
    hook: `Understand option ${index}`,
    cta: 'Talk with TRA',
    offer: null,
    soWhat: {
      surfaceMessage: `Surface message ${index}`,
      functionalConsequence: `Functional consequence ${index}`,
      meaningfulOutcome: `Meaningful outcome ${index}`,
    },
    execution: {
      subjectSource,
      composition: compositions[index - 1] || 'comparison',
      imageTreatment: imageTreatments[index - 1] || 'documentary',
      textDensity: 'medium' as const,
      ctaTreatment: 'button' as const,
      typographyHierarchy: 'headline-dominant' as const,
    },
    visualDirection: `Distinct visual direction ${index}`,
  },
  selectionReason: `Distinct strategic fit ${index}`,
});
const batchPlan = (count: number) => ({
  creatives: Array.from({ length: count }, (_, index) =>
    plannedCreative(index + 1)
  ),
  plannerModel: 'gpt-6-astra',
  reasoningEffort: 'medium' as const,
});

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
  contentHash: contentHash(PNG),
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
  variationCount = 2,
  videoFrameSelection?: object,
  placement?: unknown,
  requestExtras?: object
) =>
  new Request('http://localhost/api/creatives/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceAssets,
      ...(companyProfile ? { companyProfile } : {}),
      ...(videoFrameSelection ? { videoFrameSelection } : {}),
      ...(placement !== undefined ? { placement } : {}),
      ...requestExtras,
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
let readImageById: ReturnType<typeof vi.fn>;
let saveImage: ReturnType<typeof vi.fn>;

it('uses a seeded document and rich concept from the real planner through rendering and saved planning without uploads', async () => {
  const { conceptDetails } = await import('../fixtures/creative-concept-details');
  const original = await vi.importActual<typeof import('@/lib/ai/creative-planner')>('@/lib/ai/creative-planner');
  mocks.planCreativeBatch.mockImplementation(original.planCreativeBatch);
  const first = plannedCreative(1);
  const plan = { creatives: [
    { ...first, strategy: { ...first.strategy, execution: { ...first.strategy.execution, taxDocumentReference: 'irs-notice-v1' } } },
    plannedCreative(2),
  ].map(concept => ({ ...concept, strategy: { ...concept.strategy, conceptDetails: { ...conceptDetails, proposition: `Different proposition ${concept.index}` } }, referenceChoices: { angleSource: null, layoutSource: null } })) };
  const requests: Array<{ url: string; body: string | FormData }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body as string | FormData });
    if (url.endsWith('/responses') && JSON.parse(String(init.body)).text.format.name === 'tra_portfolio_audit') {
      const { groups, executionNotes } = portfolioAudit();
      return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ groups, executionNotes }) }] }] });
    }
    return url.endsWith('/responses')
      ? Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(plan) }] }] })
      : Response.json({ data: [{ b64_json: PNG.toString('base64') }] });
  }));
  const events = await readStreamEvents(await POST(generationRequest([], {
    knowledgeBase: { companySummary: 'PLANNER_ONLY_SUMMARY' },
    guardrails: { requiredDisclaimers: 'Results vary.' },
  })));
  expect(events.filter(event => event.event === 'creative')).toHaveLength(2);
  expect(events.some(event => event.event === 'error')).toBe(false);
  const planner = JSON.parse(requests.find(request => request.url.endsWith('/responses'))!.body as string);
  expect(planner.input[0].content[0].text).toContain('Built-in tax-document references');
  expect(planner.input[1].content[0].text).toContain('PLANNER_ONLY_SUMMARY');
  expect(planner.text.format.schema.properties.creatives.items.properties.strategy.properties.execution.required).toContain('taxDocumentReference');
  const edit = requests.find(request => request.url.endsWith('/images/edits'))!.body as FormData;
  const attached = edit.getAll('image[]') as File[];
  expect(attached).toHaveLength(1);
  expect(contentHash(Buffer.from(await attached[0].arrayBuffer()))).toBe(TAX_DOCUMENT_REFERENCES[0].sha256);
  const ordinary = JSON.parse(requests.find(request => request.url.endsWith('/images/generations'))!.body as string);
  for (const prompt of [String(edit.get('prompt')), ordinary.prompt]) {
    expect(prompt).toContain('ONE-AD RENDER BRIEF v1');
    expect(prompt).toContain('Results vary.');
    expect(prompt).toContain(conceptDetails.visualMechanism);
    expect(prompt).toContain(conceptDetails.compositionInstructions);
    expect(prompt).not.toContain(conceptDetails.proposition);
    expect(prompt).not.toContain('PLANNER_ONLY_SUMMARY');
    expect(prompt).not.toContain('Create compliant TRA concepts.');
    expect(prompt).not.toContain('Distinct strategic fit');
  }
  expect(ordinary.prompt).not.toContain('DOCUMENT-ONLY REFERENCE');
  expect(readMediaById).not.toHaveBeenCalled();
  const records = mocks.saveCreativeBatch.mock.calls.flatMap(([batch]) => batch);
  const saved = records.find(record => record.planning.strategy.execution.taxDocumentReference === 'irs-notice-v1');
  expect(parseCreativePlanning(JSON.parse(JSON.stringify(saved.planning)))?.strategy.execution.taxDocumentReference).toBe('irs-notice-v1');
  expect(parseCreativePlanning(JSON.parse(JSON.stringify(saved.planning)))?.strategy.conceptDetails).toEqual(plan.creatives[0].strategy.conceptDetails);
  expect(parseCreativePlanning(JSON.parse(JSON.stringify(saved.planning)))?.portfolioAudit).toEqual(portfolioAudit());
  expect(saved.generationProvenance.imageGeneration.prompt).not.toContain(portfolioAudit().executionNotes);
  expect(saved.generationProvenance.imageGeneration.prompt).toContain(TAX_DOCUMENT_REFERENCES[0].sha256);
});

it.each(['SQUARE_1_1', 'VERTICAL_9_16'] as const)('returns actual prompt/model and placement rules for prompt-only %s', async (placement) => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );
  vi.stubGlobal('fetch', fetchMock);

  const result = await generatePromptOnlyCreativeImage({
    primaryFormat: 'direct-response',
    placement,
    context: 'Approved prompt-only context',
    copy: { headline: 'Headline', primaryText: 'Primary', description: 'Description' },
    reserveLogoArea: placement === 'VERTICAL_9_16',
  });
  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

  expect(result.buffer).toEqual(PNG);
  expect(result.prompt).toBe(body.prompt);
  expect(result.model).toBe(body.model);
  expect(body.model).toBe('gpt-image-2.5-sunburst');
  expect(result.routing).toMatchObject({ operationType: 'PROMPT_GENERATION', fallbackUsed: false });
  if (placement === 'VERTICAL_9_16') {
    expect(body.prompt).toContain('x=70..1081, y=287..1330');
    expect(body.prompt).toContain('x=105..401, y=322..546');
    expect(body.prompt).toContain('invisible composition constraint');
    expect(body.prompt).toContain('do not render a placeholder, box, panel, border, dashed outline');
  } else {
    expect(body.prompt).not.toContain('Stories');
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.humanOptions.mockResolvedValue([]);
  mocks.resolveHuman.mockReset();
  mocks.getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' });
  mocks.requireOperatorQuota.mockResolvedValue(null);
  mocks.compositeCreativeBrandLogo.mockReset().mockImplementation(async (buffer) => buffer);
  mocks.saveCreativeBatch.mockReset().mockImplementation(async (records) => records);
  mocks.validateGeneratedCreativeImage.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  storedById = {};
  readMediaById = vi.fn(async (id: string) => storedById[id] || null);
  readImageById = vi.fn(async () => null);
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
    readImageById,
    saveImage,
  });
  mocks.getOrAnalyzeLayoutBlueprint.mockResolvedValue(layoutResolution);
  mocks.analyzeTraSourceCreative.mockResolvedValue(analysis);
  mocks.analyzeReferenceCreative.mockResolvedValue(analysis);
  mocks.analyzeApprovedTraVideoFrames.mockResolvedValue(analysis);
  mocks.listReferenceLibrary.mockResolvedValue([]);
  mocks.planCreativeBatch.mockImplementation(
    async ({ count, referenceCatalog = [] }: { count: number; referenceCatalog?: ReferencePlanningCandidate[] }) => ({
      ...batchPlan(count), creatives: batchPlan(count).creatives.map(concept => ({ ...concept, strategy: { ...concept.strategy,
        referenceSelection: resolveReferenceSelection({ angleSource: null, layoutSource: referenceCatalog[0]?.referenceId ?? null }, referenceCatalog),
      } })),
    })
  );
  mocks.generateApprovedTraReferenceCreativeImage.mockResolvedValue(imageResultFor('TRA_REFERENCE_GENERATION'));
  mocks.generateApprovedTraVideoFrameCreativeImage.mockImplementation(
    async ({ frames }) => ({ ...imageResultFor('TRA_VIDEO_FRAME_GENERATION'), providerFrames: [frames.at(-1)] })
  );
  mocks.loadVideoSelectionContext.mockResolvedValue(null);
  mocks.getApprovedTraVideoFrames.mockImplementation(async (source) => ({
    source,
    sourceVideoContentHash: contentHash(source.stored.buffer),
    durationMs: 1_000,
    reused: false,
    frames: [0, 500].map((timestampMs, frameIndex) =>
      ({
        frameIndex,
        timestampMs,
        mimeType: 'image/png',
        buffer: PNG,
        frameSha256: contentHash(PNG),
        byteLength: PNG.byteLength,
        sourceRole: 'TRA_VIDEO',
        sourceVideoMediaId: source.media.id,
        sourceVideoFileName: source.media.fileName,
        sourceVideoContentHash: contentHash(source.stored.buffer),
        approvedHumanSource: true,
        cacheKey: `derived/video-frames/${source.media.id}/${contentHash(source.stored.buffer)}/frame-${String(frameIndex).padStart(3, '0')}.png`,
      })
    ),
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
    for (const { data } of events.filter(({ event }) => event === 'creative')) {
      const provenance = parseCreativeGenerationProvenance(
        (data.creative as { generationProvenance?: unknown }).generationProvenance
      );
      expect(provenance).toMatchObject({
        imageGeneration: { model: 'gpt-image-2.5-sunburst', routing: { operationType: 'LAYOUT_REFERENCE_GENERATION' } },
        requestedSources: [
          { role: 'LAYOUT_REFERENCE', mediaId: layoutId, sha256: contentHash(PNG) },
        ],
        attachedSource: null,
        analysisSources: [
          {
            type: 'LAYOUT_REFERENCE',
            mediaId: layoutId,
            sha256: contentHash(PNG),
            layoutCache: {
              sourceSha256: contentHash(PNG),
              analyzerModel: layoutResolution.analyzerModel,
              schemaVersion: 1,
            },
          },
        ],
      });
      expect(provenance?.imageGeneration.prompt).toContain('"layoutBlueprint"');
    }
    expect(events.at(-1)).toMatchObject({
      event: 'complete',
      data: { requestedCount: 2, successfulCount: 2, failedCount: 0 },
    });
    expect(mocks.planCreativeBatch.mock.calls[0][0].context).toContain('APPROVED TRA COMPANY CONTEXT');
    expect(mocks.planCreativeBatch.mock.calls[0][0].context).toContain('Runtime approved TRA summary.');
    expect(mocks.planCreativeBatch.mock.calls[0][0].context).toContain('Runtime approved claim.');
    expect(mocks.planCreativeBatch.mock.calls[0][0].context).toContain('STRUCTURED LAYOUT BLUEPRINT');
    expect(mocks.generateApprovedTraReferenceCreativeImage).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).not.toHaveBeenCalled();

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      const body = JSON.parse(String(options?.body)) as {
        prompt?: string;
        quality?: string;
        size?: string;
      };
      expect(body.quality).toBe('high');
      expect(body.size).toBe('1024x1024');
      expect(body.prompt).toContain('1:1 canvas (1024x1024)');
      expect(body.prompt).not.toContain('APPROVED TRA COMPANY CONTEXT');
      expect(body.prompt).toContain('"layoutBlueprint"');
      expect(body.prompt).toContain('HUMAN_PLACEHOLDER regions describe geometry only');
      expect(body.prompt).toContain('This planned concept is explicitly non-human');
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
    expect(
      await Promise.all(
        saveImage.mock.calls.map(async ([file]) =>
          Buffer.from(await (file as File).arrayBuffer())
        )
      )
    ).toEqual([PNG, PNG]);
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(2);
    for (const { data } of events.filter(({ event }) => event === 'creative')) {
      expect(
        parseCreativeGenerationProvenance(
          (data.creative as { generationProvenance?: unknown }).generationProvenance
        )
      ).toMatchObject({
        requestedSources: [
          { role: 'TRA_VIDEO', mediaId: videoId, sha256: contentHash(MP4) },
        ],
        attachedSource: {
          type: 'TRA_VIDEO_FRAMES',
          mediaId: videoId,
          sourceSha256: contentHash(MP4),
          selectionMode: 'AUTOMATIC',
          frames: [
            { timestampMs: 500, approvedPngSha256: contentHash(PNG) },
          ],
        },
      });
    }
  });

  it('regenerates only selected library frames for analysis and image generation and streams their provenance', async () => {
    const videoId = mediaId('9');
    storedById[videoId] = video('9');
    const sourceVideoContentHash = contentHash(storedById[videoId].buffer);
    const selectedFrames = [
      {
        frameIndex: 0,
        timestampMs: 250,
        mimeType: 'image/png',
        buffer: PNG,
        frameSha256: contentHash(PNG),
        byteLength: PNG.byteLength,
        sourceRole: 'TRA_VIDEO',
        sourceVideoMediaId: videoId,
        sourceVideoFileName: storedById[videoId].fileName,
        sourceVideoContentHash,
        approvedHumanSource: true,
        cacheKey: `derived/video-frames/${videoId}/${sourceVideoContentHash}/frame-000.png`,
      },
    ];
    const selectionProvenance = [
      {
        frameIndex: 0,
        libraryFrameId: LIBRARY_FRAME_ID,
        candidateFrameSha256: 'c'.repeat(64),
        timestampMs: 250,
        approvedPngSha256: contentHash(PNG),
      },
    ];
    const library = {
      id: LIBRARY_ID,
      sourceVideoMediaId: videoId,
      sourceVideoContentHash,
    };
    mocks.loadVideoSelectionContext.mockResolvedValue({ library, manifest: null });
    mocks.extractVideoSelectionFrames.mockImplementation(async (source) => ({
      source,
      sourceVideoContentHash,
      durationMs: 1_000,
      reused: false,
      frames: selectedFrames,
      selectionProvenance,
    }));

    const response = await POST(
      generationRequest(
        [{ mediaId: videoId, role: 'TRA_VIDEO' }],
        undefined,
        2,
        selectionFor(sourceVideoContentHash)
      )
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.getApprovedTraVideoFrames).not.toHaveBeenCalled();
    expect(mocks.loadVideoSelectionContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'TRA_VIDEO', media: expect.objectContaining({ id: videoId }) })
    );
    expect(mocks.extractVideoSelectionFrames).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'TRA_VIDEO' }),
      { library, manifest: null },
      [LIBRARY_FRAME_ID]
    );
    expect(mocks.analyzeApprovedTraVideoFrames).toHaveBeenCalledWith(
      expect.objectContaining({ frames: selectedFrames })
    );
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).toHaveBeenCalledTimes(2);
    for (const [call] of mocks.generateApprovedTraVideoFrameCreativeImage.mock.calls) {
      expect(call.frames).toBe(selectedFrames);
    }
    for (const { data } of events.filter(({ event }) => event === 'creative')) {
      expect(data.creative).toMatchObject({
        videoFrameSelection: {
          libraryId: LIBRARY_ID,
          sourceVideoMediaId: videoId,
          sourceVideoContentHash,
          frames: selectionProvenance,
        },
        generationProvenance: {
          attachedSource: {
            type: 'TRA_VIDEO_FRAMES',
            mediaId: videoId,
            sourceSha256: sourceVideoContentHash,
            selectionMode: 'USER_SELECTED',
            frames: [
              { timestampMs: 250, approvedPngSha256: contentHash(PNG) },
            ],
          },
        },
      });
      expect(
        parseCreativeGenerationProvenance(
          (data.creative as { generationProvenance?: unknown }).generationProvenance
        )
      ).not.toBeNull();
    }
  });

  it('rejects stale or missing selected-frame state before paid generation calls', async () => {
    const videoId = mediaId('9');
    storedById[videoId] = video('9');
    const selection = selectionFor(contentHash(storedById[videoId].buffer));

    const stale = await POST(
      generationRequest(
        [{ mediaId: videoId, role: 'TRA_VIDEO' }],
        undefined,
        2,
        selectionFor('f'.repeat(64))
      )
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: 'The selected TRA video frames are stale. Reanalyze the video and select frames again.',
    });

    const missing = await POST(
      generationRequest(
        [{ mediaId: videoId, role: 'TRA_VIDEO' }],
        undefined,
        2,
        selection
      )
    );
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toEqual({
      error: 'The selected TRA video frame library is missing or invalid. Reanalyze the video and select frames again.',
    });

    mocks.loadVideoSelectionContext.mockResolvedValue({
      library: { id: `video-library:${'e'.repeat(64)}` }, manifest: null,
    });
    const mismatchedLibrary = await POST(
      generationRequest(
        [{ mediaId: videoId, role: 'TRA_VIDEO' }],
        undefined,
        2,
        selection
      )
    );
    expect(mismatchedLibrary.status).toBe(409);
    await expect(mismatchedLibrary.json()).resolves.toEqual({
      error: 'The selected TRA video frame library does not match this request. Select frames again.',
    });
    expect(mocks.getApprovedTraVideoFrames).not.toHaveBeenCalled();
    expect(mocks.extractVideoSelectionFrames).not.toHaveBeenCalled();
    expect(mocks.analyzeApprovedTraVideoFrames).not.toHaveBeenCalled();
    expect(mocks.planCreativeBatch).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns production 404 for selected-frame generation before storage or providers', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await POST(
      generationRequest(
        [{ mediaId: mediaId('9'), role: 'TRA_VIDEO' }],
        undefined,
        2,
        selectionFor('b'.repeat(64))
      )
    );

    expect(response.status).toBe(404);
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(mocks.loadVideoSelectionContext).not.toHaveBeenCalled();
    expect(mocks.extractVideoSelectionFrames).not.toHaveBeenCalled();
    expect(mocks.planCreativeBatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
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
      expect(call.context).toContain('ONE-AD RENDER BRIEF v1');
      expect(call.context).not.toContain('Runtime TRA layout-plus-video context.');
      expect(call.context).toContain('"layoutBlueprint"');
      expect(call.context).toContain('TEXT_LEFT_VISUAL_RIGHT');
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
    const events = await readStreamEvents(response);

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
      expect(call.context).toContain('ONE-AD RENDER BRIEF v1');
      expect(call.context).not.toContain('Runtime calm and direct.');
      expect(call.context).toContain('"layoutBlueprint"');
    }
    expect(fetch).not.toHaveBeenCalled();
    for (const { data } of events.filter(({ event }) => event === 'creative')) {
      expect(
        parseCreativeGenerationProvenance(
          (data.creative as { generationProvenance?: unknown }).generationProvenance
        )
      ).toMatchObject({
        requestedSources: [
          { role: 'TRA_REFERENCE', mediaId: traId, sha256: contentHash(PNG) },
          { role: 'TRA_VIDEO', mediaId: videoId, sha256: contentHash(MP4) },
          { role: 'LAYOUT_REFERENCE', mediaId: layoutId, sha256: contentHash(PNG) },
        ],
        attachedSource: {
          type: 'TRA_REFERENCE_IMAGE',
          mediaId: traId,
          sha256: contentHash(PNG),
        },
        analysisSources: [
          { type: 'LAYOUT_REFERENCE', mediaId: layoutId, sha256: contentHash(PNG) },
        ],
      });
    }
  });

  it('uses external library references only as selection metadata', async () => {
    const traId = mediaId('f');
    const logoId = mediaId('7');
    const firstReference = libraryItem('1');
    const secondReference = libraryItem('2');
    storedById[traId] = image('f');
    readImageById.mockResolvedValue(image('7'));
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
      generationRequest(
        [{ mediaId: traId, role: 'TRA_REFERENCE' }],
        undefined,
        2,
        undefined,
        undefined,
        { brandLogoMediaId: logoId }
      )
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(readMediaById).toHaveBeenCalledTimes(1);
    expect(readMediaById).toHaveBeenCalledWith(traId);
    expect(mocks.getOrAnalyzeLayoutBlueprint).toHaveBeenCalledTimes(3);
    expect(mocks.getApprovedTraVideoFrames).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraReferenceCreativeImage).toHaveBeenCalledTimes(2);
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).not.toHaveBeenCalled();
    expect(mocks.planCreativeBatch).toHaveBeenCalledTimes(1);
    expect(mocks.planCreativeBatch).toHaveBeenCalledWith(
      expect.objectContaining({ hasApprovedHumanSource: true })
    );
    expect(mocks.planCreativeBatch.mock.calls[0][0].context).toContain(
      `Reference ${firstReference.id}`
    );
    expect(
      mocks.generateApprovedTraReferenceCreativeImage.mock.calls.every(
        ([call]) => call.source === storedById[traId]
      )
    ).toBe(true);
    const firstCall = mocks.generateApprovedTraReferenceCreativeImage.mock.calls[0][0];
    expect(firstCall.copy).toEqual(plannedCreative(1).copy);
    expect(firstCall.context).not.toContain('Distinct strategic fit 1');
    expect(firstCall.context).not.toContain('Surface message 1');
    expect(firstCall.context).toContain('"composition": "single-focus"');
    expect(firstCall.context).toContain('Distinct visual direction 1');
    expect(firstCall.context).toContain('This planned concept is explicitly non-human');
    const creatives = events
      .filter(({ event }) => event === 'creative')
      .map(({ data }) => data.creative as { index: number; planning?: unknown });
    expect(creatives).toHaveLength(2);
    expect(creatives.find(({ index }) => index === 1)?.planning).toMatchObject({
      strategy: plannedCreative(1).strategy,
      selectionReason: 'Distinct strategic fit 1',
      model: 'gpt-6-astra',
      reasoningEffort: 'medium',
    });
    for (const { data } of events.filter(({ event }) => event === 'creative')) {
      expect(
        parseCreativeGenerationProvenance(
          (data.creative as { generationProvenance?: unknown }).generationProvenance
        )
      ).toMatchObject({
        requestedSources: [
          { role: 'TRA_REFERENCE', mediaId: traId, sha256: contentHash(PNG) },
        ],
        attachedSource: {
          type: 'TRA_REFERENCE_IMAGE', mediaId: traId, sha256: contentHash(PNG),
        },
        analysisSources: [
          { type: 'REFERENCE_LIBRARY', mediaId: firstReference.id },
          { type: 'REFERENCE_LIBRARY', mediaId: secondReference.id },
        ],
        logoOverlaySource: { mediaId: logoId, sha256: contentHash(PNG) },
      });
    }
  });

  it('allows TRA reference generation with an empty optional reference library', async () => {
    const traId = mediaId('6');
    storedById[traId] = image('6');

    const response = await POST(
      generationRequest([{ mediaId: traId, role: 'TRA_REFERENCE' }])
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.selectBestReferenceCreatives).not.toHaveBeenCalled();
    expect(mocks.planCreativeBatch).toHaveBeenCalledTimes(1);
    expect(mocks.generateApprovedTraReferenceCreativeImage).toHaveBeenCalledTimes(2);
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(2);
  });

  it('uses at most the available optional references without constraining the full batch', async () => {
    const traId = mediaId('5');
    const reference = libraryItem('4');
    storedById[traId] = image('5');
    readImageById.mockResolvedValue(image('4'));
    mocks.planCreativeBatch.mockImplementation(async ({ referenceCatalog }) => ({ ...batchPlan(2),
      creatives: batchPlan(2).creatives.map((concept, index) => ({ ...concept, strategy: { ...concept.strategy,
        referenceSelection: resolveReferenceSelection({ angleSource: traId, layoutSource: index === 0 ? reference.id : null }, referenceCatalog),
      } })),
    }));
    mocks.listReferenceLibrary.mockResolvedValue([reference]);
    mocks.selectBestReferenceCreatives.mockResolvedValue([
      {
        item: reference,
        imageUrl: `http://localhost${reference.url}`,
        selectionReason: 'Useful optional layout cue',
      },
    ]);

    const response = await POST(
      generationRequest([{ mediaId: traId, role: 'TRA_REFERENCE' }])
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.selectBestReferenceCreatives).toHaveBeenCalledWith(
      expect.objectContaining({ requestedCount: 1 })
    );
    expect(mocks.planCreativeBatch.mock.calls[0][0].context).toContain(
      'do not need to be used by every output'
    );
    expect(mocks.generateApprovedTraReferenceCreativeImage).toHaveBeenCalledTimes(2);
    const creatives = events
      .filter(({ event }) => event === 'creative')
      .map(({ data }) => data.creative as { index: number; referenceImageId?: string });
    expect(creatives.find(({ index }) => index === 1)?.referenceImageId).toBe(reference.id);
    expect(creatives.find(({ index }) => index === 2)?.referenceImageId).toBeUndefined();
    const records = mocks.saveCreativeBatch.mock.calls.flatMap(([batch]) => batch);
    const saved = records.map(record => parseCreativePlanning(JSON.parse(JSON.stringify(record.planning))));
    expect(saved.every(Boolean)).toBe(true);
    expect(saved[0]?.strategy.referenceSelection).toMatchObject({ angleSource: traId, layoutSource: reference.id, referenceRelationship: 'mixed' });
    expect(saved[1]?.strategy.referenceSelection?.layoutSource).toBeNull();
    expect(saved[0]?.referenceCatalog?.map(item => item.referenceId)).toEqual([traId, reference.id]);
  });
});

describe('progressive creative delivery', () => {
  const prepared = () => prepareCreativeGeneration({ sourceAssets: [], placement: 'SQUARE_1_1', context: 'Frozen direction', variationCount: 2 }, 'http://localhost');
  it('uses the reserved identity and checks work ownership before provider, image and metadata writes', async () => {
    const context = await prepared(), creativeId = `creative_${'a'.repeat(32)}`;
    const assertCurrentWork = vi.fn(async () => {});
    const result = await renderPlannedCreative(context.batchPlan.creatives[0], context, { creativeId, assertCurrentWork });
    expect(result.id).toBe(creativeId);
    expect(result.identity?.conceptId).toBe(creativeId);
    expect(mocks.saveCreativeBatch.mock.calls[0][0][0].id).toBe(creativeId);
    expect(assertCurrentWork).toHaveBeenCalledTimes(3);
    expect(assertCurrentWork.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[0]);
    expect(assertCurrentWork.mock.invocationCallOrder[1]).toBeLessThan(saveImage.mock.invocationCallOrder[0]);
    expect(assertCurrentWork.mock.invocationCallOrder[2]).toBeLessThan(mocks.saveCreativeBatch.mock.invocationCallOrder[0]);
  });
  it.each([1, 2, 3])('stops stale work at ownership checkpoint %s without saving a creative record', async checkpoint => {
    const context = await prepared(); let calls = 0;
    await expect(renderPlannedCreative(context.batchPlan.creatives[0], context, { assertCurrentWork: async () => {
      if (++calls === checkpoint) throw new Error('Lease lost');
    } })).rejects.toThrow('Lease lost');
    expect(mocks.saveCreativeBatch).not.toHaveBeenCalled();
    expect(saveImage).toHaveBeenCalledTimes(checkpoint === 3 ? 1 : 0);
    expect(fetch).toHaveBeenCalledTimes(checkpoint === 1 ? 0 : 1);
  });
  it('rejects a malformed reserved identity before any image provider call', async () => {
    const context = await prepared();
    await expect(renderPlannedCreative(context.batchPlan.creatives[0], context, { creativeId: 'bad' })).rejects.toThrow('reserved creative ID');
    expect(fetch).not.toHaveBeenCalled();
    expect(saveImage).not.toHaveBeenCalled();
  });
  it('saves final logo pixels and metadata before marking a creative as saved', async () => {
    const finalPixels = Buffer.from('composited PNG fixture');
    readImageById.mockResolvedValue(image('7'));
    mocks.compositeCreativeBrandLogo.mockResolvedValue(finalPixels);
    const response = await POST(generationRequest([], undefined, 2, undefined, 'PORTRAIT_4_5', { brandLogoMediaId: mediaId('7') }));
    const events = await readStreamEvents(response);
    expect(mocks.compositeCreativeBrandLogo).toHaveBeenCalledTimes(2);
    expect(mocks.compositeCreativeBrandLogo).toHaveBeenCalledWith(PNG, PNG, 'PORTRAIT_4_5');
    expect(await Promise.all(saveImage.mock.calls.map(async ([file]) => Buffer.from(await file.arrayBuffer())))).toEqual([finalPixels, finalPixels]);
    expect(mocks.compositeCreativeBrandLogo.mock.invocationCallOrder[0]).toBeLessThan(saveImage.mock.invocationCallOrder[0]);
    expect(saveImage.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveCreativeBatch.mock.invocationCallOrder[0]);
    const saved = mocks.saveCreativeBatch.mock.calls.flatMap(([records]) => records);
    for (const { data } of events.filter(({ event }) => event === 'creative')) {
      const creative = data.creative as { id: string; image: unknown; finalization: unknown };
      const record = saved.find((item) => item.id === creative.id);
      expect(record).toMatchObject({ image: creative.image, placement: 'PORTRAIT_4_5', identity: expect.any(Object), planning: expect.any(Object), generationProvenance: expect.any(Object) });
      expect(creative.finalization).toEqual({ status: 'SAVED', createdAt: record.createdAt });
    }
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(2);
  });

  it('does not report success when a library save fails and retains saved siblings', async () => {
    mocks.saveCreativeBatch.mockRejectedValueOnce(new Error('fixture storage failure'));
    const events = await readStreamEvents(await POST(generationRequest([], undefined, 2)));
    expect(mocks.compositeCreativeBrandLogo).not.toHaveBeenCalled();
    expect(mocks.saveCreativeBatch).toHaveBeenCalledTimes(2);
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(1);
    expect(events.find(({ event }) => event === 'error')?.data.error).toContain('could not be completed');
    expect(events.at(-1)?.data).toMatchObject({ successfulCount: 1, failedCount: 1 });
  });
  it('surfaces invalid image output without saving it and retains successful siblings', async () => {
    mocks.validateGeneratedCreativeImage.mockRejectedValueOnce(new GeneratedImageValidationError('Generated image must be 1024x1280. Regenerate this creative.'));
    const response = await POST(generationRequest([], undefined, 2, undefined, 'PORTRAIT_4_5'));
    const events = await readStreamEvents(response);
    expect(mocks.validateGeneratedCreativeImage).toHaveBeenCalledTimes(2);
    expect(mocks.validateGeneratedCreativeImage).toHaveBeenCalledWith(PNG, 'PORTRAIT_4_5');
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(events.filter(({ event }) => event === 'creative')).toHaveLength(1);
    expect(events.find(({ event }) => event === 'error')?.data.error).toContain('Regenerate this creative');
    expect(events.at(-1)?.data).toMatchObject({ successfulCount: 1, failedCount: 1 });
  });

  it('routes only a selected library human and saves its stable ID and source provenance', async () => {
    const humanId = `human_${'a'.repeat(64)}`; const traId = mediaId('4'); const videoId = mediaId('3');
    storedById[traId] = image('4');
    const frame = { frameIndex:0,timestampMs:1000,mimeType:'image/png',buffer:PNG,frameSha256:contentHash(PNG),byteLength:PNG.length,
      sourceRole:'TRA_VIDEO',sourceVideoMediaId:videoId,sourceVideoFileName:`${videoId}.mp4`,sourceVideoContentHash:'b'.repeat(64),approvedHumanSource:true,cacheKey:null };
    const source = { libraryId:`video-library:${'c'.repeat(64)}`,sourceVideoMediaId:videoId,sourceVideoContentHash:'b'.repeat(64),
      frames:[{frameIndex:0,libraryFrameId:`video-frame:${'d'.repeat(64)}`,candidateFrameSha256:'e'.repeat(64),timestampMs:1000,approvedPngSha256:contentHash(PNG)}] };
    mocks.humanOptions.mockResolvedValue([{id:humanId,sourceName:'TRA video',description:'Approved explanatory presenter'}]);
    mocks.resolveHuman.mockResolvedValue({record:{id:humanId,source},selected:{frames:[frame]}});
    mocks.planCreativeBatch.mockResolvedValue({ ...batchPlan(2), creatives:batchPlan(2).creatives.map((item,index)=>index===0
      ? {...item,strategy:{...item.strategy,approvedHumanId:humanId,execution:{...item.strategy.execution,subjectSource:'approved-tra-human'}}} : item) });
    const events = await readStreamEvents(await POST(generationRequest([{mediaId:traId,role:'TRA_REFERENCE'}])));
    expect(mocks.planCreativeBatch.mock.calls[0][0].approvedHumanOptions[0].id).toBe(humanId);
    expect(mocks.resolveHuman).toHaveBeenCalledExactlyOnceWith(humanId);
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({frames:[frame]}));
    expect(mocks.generateApprovedTraReferenceCreativeImage).toHaveBeenCalledTimes(1);
    const saved = mocks.saveCreativeBatch.mock.calls.flatMap(call=>call[0]).find(item=>item.index===1);
    expect(saved.planning.strategy.approvedHumanId).toBe(humanId); expect(saved.videoFrameSelection).toEqual(source);
    expect(parseCreativePlanning(saved.planning)).not.toBeNull();
    expect(parseCreativeGenerationProvenance(saved.generationProvenance)).toMatchObject({
      requestedSources:expect.arrayContaining([{role:'TRA_VIDEO',mediaId:videoId,sha256:'b'.repeat(64)}]),
      attachedSource:{type:'TRA_VIDEO_FRAMES',mediaId:videoId,sourceSha256:'b'.repeat(64)},
    });
    expect(events.at(-1)?.data.successfulCount).toBe(2);
    mocks.resolveHuman.mockRejectedValue(new Error('Human inactive'));
    const failed = await readStreamEvents(await POST(generationRequest([{mediaId:traId,role:'TRA_REFERENCE'}])));
    expect(failed.at(-1)?.data).toMatchObject({successfulCount:1,failedIndexes:[1]});
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).toHaveBeenCalledTimes(1);
  });
  it('streams exact prompt-only image provenance without fabricated sources', async () => {
    const response = await POST(generationRequest([], undefined, 2));
    const events = await readStreamEvents(response);
    const creative = events.find(({ event }) => event === 'creative')?.data.creative as {
      generationProvenance?: unknown;
    };
    const provenance = parseCreativeGenerationProvenance(
      creative.generationProvenance
    );

    expect(provenance).toMatchObject({
      version: 1,
      imageGeneration: { model: 'gpt-image-2.5-sunburst', routing: { operationType: 'PROMPT_GENERATION' } },
      requestedSources: [],
      attachedSource: null,
      analysisSources: [],
    });
    expect(provenance?.imageGeneration.prompt).toContain('ONE-AD RENDER BRIEF v1');
  });

  it('streams a GENERATE identity for initial portrait generation', async () => {
    const response = await POST(generationRequest([], undefined, 2, undefined, 'PORTRAIT_4_5'));
    const events = await readStreamEvents(response);
    const creative = events.find(({ event }) => event === 'creative')?.data.creative as {
      id: string;
      identity?: unknown;
    };

    expect(parseCreativeIdentity(creative.identity, creative.id)).toMatchObject({
      conceptId: creative.id,
      parentCreativeId: null,
      operation: 'GENERATE',
    });
  });

  it('stops before image generation or saving when planning fails to complete', async () => {
    mocks.planCreativeBatch.mockRejectedValue(new Error('Creative planning did not complete within its response limit.'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await POST(generationRequest([]));
    expect(response.status).toBe(500);
    expect(mocks.generateApprovedTraReferenceCreativeImage).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(saveImage).not.toHaveBeenCalled();
    expect(mocks.saveCreativeBatch).not.toHaveBeenCalled();
  });

  it('rejects a genuinely duplicate planner batch before image generation or saving', async () => {
    const duplicate = plannedCreative(2);
    mocks.planCreativeBatch.mockResolvedValue({
      ...batchPlan(2),
      creatives: [
        plannedCreative(1),
        { ...duplicate, copy: { ...duplicate.copy, headline: 'Headline 1' } },
      ],
    });

    const response = await POST(generationRequest([]));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error:
        'Creative planner returned an insufficiently diverse batch: Variations 1 and 2 have duplicate headlines.',
    });
    expect(mocks.selectBestReferenceCreatives).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraReferenceCreativeImage).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraVideoFrameCreativeImage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(saveImage).not.toHaveBeenCalled();
  });

  it('requests and streams a vertical placement for prompt-only generation', async () => {
    const response = await POST(
      generationRequest([], undefined, 2, undefined, 'VERTICAL_9_16')
    );
    const events = await readStreamEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.planCreativeBatch).toHaveBeenCalledWith(
      expect.objectContaining({ hasApprovedHumanSource: false })
    );
    for (const [, options] of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      const body = JSON.parse(String(options?.body)) as {
        prompt: string;
        size: string;
      };
      expect(body.size).toBe('1152x2048');
      expect(body.prompt).toContain('9:16 canvas (1152x2048)');
      expect(body.prompt).toContain('do not crop or stretch a square design');
    }
    expect(
      events
        .filter(({ event }) => event === 'creative')
        .every(({ data }) =>
          (data.creative as { placement?: string }).placement === 'VERTICAL_9_16'
        )
    ).toBe(true);
  });

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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const requestBody = JSON.parse(String(options?.body));
        if (requestBody.prompt.includes('Headline: Headline 1')) {
          return new Response('provider unavailable', { status: 503 });
        }
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
      data: { index: 1, error: 'Creative 1 could not be completed.' },
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
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
  });

  it.each([429, 503])('rejects quota admission %i before hydration, planning, provider, or saving', async (status) => {
    mocks.requireOperatorQuota.mockResolvedValue(new Response(JSON.stringify({ error: 'Quota unavailable.' }), {
      status, headers: { 'Cache-Control': 'private, no-store', ...(status === 429 ? { 'Retry-After': '60' } : {}) },
    }));
    const response = await POST(generationRequest([], undefined, 2));
    expect(response.status).toBe(status);
    expect(response.headers.get('Retry-After')).toBe(status === 429 ? '60' : null);
    expect(mocks.requireOperatorQuota).toHaveBeenCalledWith('operator', 'CREATIVE_GENERATION', 2);
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(mocks.planCreativeBatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.saveCreativeBatch).not.toHaveBeenCalled();
  });

  it('rejects an unsupported placement before storage or provider work', async () => {
    const response = await POST(
      generationRequest([], undefined, 2, undefined, 'LANDSCAPE_16_9')
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'placement is unsupported',
    });
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(mocks.planCreativeBatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
