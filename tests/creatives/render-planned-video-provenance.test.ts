import { beforeEach, describe, expect, it, vi } from 'vitest';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { approvedHumanSourceId } from '@/lib/video/approved-human';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { composeDraftVideoAssertion } from '@/lib/creatives/draft-video-assertion';
import { draftVideoGuidance, draftVideoPassage } from '../fixtures/draft-video-source';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), promptOnly: vi.fn(), saveBatch: vi.fn(), validate: vi.fn(), resolveHuman: vi.fn() }));
vi.mock('@/lib/ai/video-frame-generation', () => ({ generateApprovedTraVideoFrameCreativeImage: mocks.generate }));
vi.mock('@/lib/ai/prompt-only-generation', () => ({ generatePromptOnlyCreativeImage: mocks.promptOnly }));
vi.mock('@/lib/video/approved-human-service', () => ({ resolveApprovedHumanFrame: mocks.resolveHuman }));
vi.mock('@/lib/creatives/generated-image-validation', () => ({ validateGeneratedCreativeImage: mocks.validate }));
vi.mock('@/lib/creatives/storage', () => ({ saveCreativeBatch: mocks.saveBatch }));

const mediaId = `media_${'a'.repeat(32)}`, sourceHash = 'b'.repeat(64), frameId = `video-frame:${'c'.repeat(64)}`;
const humanId = `human_${'8'.repeat(64)}`;
const provenance = [{ frameIndex: 0, libraryFrameId: frameId, candidateFrameSha256: 'd'.repeat(64),
  timestampMs: 1200, approvedPngSha256: 'e'.repeat(64) }];
const frame = { frameIndex: 0, timestampMs: 1200, mimeType: 'image/png', buffer: Buffer.from('png'),
  frameSha256: 'e'.repeat(64), byteLength: 3, sourceRole: 'TRA_VIDEO', sourceVideoMediaId: mediaId,
  sourceVideoFileName: 'source.mp4', sourceVideoContentHash: sourceHash, approvedHumanSource: true, cacheKey: null,
  sourceOverlay: { version: 2, status: 'CLEAN' }, providerPngSha256: 'e'.repeat(64), crop: null } as any;
const attachedFrames = [{ timestampMs: 1200, approvedPngSha256: 'e'.repeat(64),
  providerPngSha256: 'e'.repeat(64), sourceOverlay: { version: 2, status: 'CLEAN' }, crop: null }];
const selection = { libraryId: `video-library:${'f'.repeat(64)}`, sourceVideoMediaId: mediaId,
  sourceVideoContentHash: sourceHash, frames: provenance };
const routing = { operationType: 'TRA_VIDEO_FRAME_GENERATION', preferredModel: 'gpt-image-2.5-sunburst',
  actualModel: 'gpt-image-2.5-sunburst', fallbackUsed: false, fallbackFromModel: null, fallbackReason: null } as const;
const frameSet = { source: {} as any, sourceVideoContentHash: sourceHash, durationMs: 2000, reused: false, frames: [frame] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generate.mockResolvedValue({ buffer: Buffer.from('image'), prompt: 'prompt', model: 'gpt-image-2.5-sunburst', routing,
    providerFrames: [frame] });
  mocks.promptOnly.mockResolvedValue({ buffer: Buffer.from('image'), prompt: 'prompt', model: 'gpt-image-2.5-sunburst', routing });
  mocks.resolveHuman.mockResolvedValue({ record: { source: selection }, selected: frameSet });
  mocks.saveBatch.mockImplementation(async records => records.map((record: object) => ({ ...record, createdAt: '2026-09-14T00:00:00.000Z' })));
});

const storage = { saveImage: vi.fn().mockResolvedValue({ id: `media_${'1'.repeat(32)}`, fileName: 'creative.png', originalName: 'creative.png',
  mimeType: 'image/png', size: 5, url: '/creative.png' }) } as any;

async function render(explicit = false, human = true, selected: typeof selection = selection, reviewed = false,
  sourceAnalysis?: import('@/lib/creatives/planning-source-packet').PlanningSourceAnalysisState, layout?: 'SELECTED' | 'IGNORED', draft = false, omitLogo = false, peoplePercent?: number) {
  const referenceCatalog = layout ? [referenceCandidate('4')] : [];
  const request = { ...portfolioRequest(), sourceAssets: [{ role: 'TRA_VIDEO', mediaId },
    ...(layout ? [{ role: 'LAYOUT_REFERENCE', mediaId: referenceCatalog[0].referenceId }] : [])],
    ...(explicit ? { videoFrameSelection: { libraryId: selected.libraryId, sourceVideoContentHash: sourceHash,
      frameIds: [selected.frames[0].libraryFrameId] } } : {}) } as any;
  if (peoplePercent !== undefined) request.peoplePercent = peoplePercent;
  if (omitLogo) { request.previewOmitBrandLogo = true; delete request.brandLogoMediaId; }
  if (reviewed) request.reviewHandoff = { choices: { video: { libraryId: selected.libraryId,
    librarySha256: '1'.repeat(64), locator: { sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash } },
    frames: [{ frameId: videoCandidateFrameId(sourceHash, 1200, 'd'.repeat(64)), representativeFrameId: frameId,
      candidateIndex: 7, timestampMs: 1200, frameSha256: 'd'.repeat(64) }] } };
  const snapshot = portfolioSnapshot(newCreativePortfolio(request));
  const item = snapshot.batchPlan.creatives[0];
  if (draft) {
    request.reviewHandoff = { choices: { frames: null }, operatorSelectedSourceGuidance: draftVideoGuidance };
    const passage = draftVideoPassage();
    const composed = composeDraftVideoAssertion({ passageId: passage.passageId, imageField: 'shortSupport' }, [passage], item.adCopy!, item.imageCopy!);
    Object.assign(item, composed, { copy: composed.adCopy });
  }
  if (human) item.strategy.execution.subjectSource = 'approved-tra-human';
  if (reviewed && (peoplePercent === undefined || human)) item.strategy.humanSourceId = approvedHumanSourceId(humanId);
  if (layout === 'SELECTED') item.strategy.referenceSelection = { angleSource: null, layoutSource: referenceCatalog[0].referenceId, referenceRelationship: 'mixed' };
  return renderPlannedCreative(item, {
    request, batchPlan: snapshot.batchPlan, referenceCatalog, selectedReferences: [],
    requestedSources: [{ role: 'TRA_VIDEO', mediaId, sha256: sourceHash }], analysisSources: [],
    reserveLogoArea: false, brandLogo: null, providerImageSource: undefined,
    videoFrameSet: frameSet, generatedVideoFrameSelection: selected, storage, sourceAnalysis,
  }, { creativeId: `creative_${'2'.repeat(32)}` });
}

async function renderCatalogHuman(legacy = false) {
  const request = portfolioRequest() as any;
  const snapshot = portfolioSnapshot(newCreativePortfolio(request));
  const item = structuredClone(snapshot.batchPlan.creatives[0]);
  item.strategy.execution.subjectSource = 'approved-tra-human';
  if (legacy) item.strategy.approvedHumanId = humanId;
  else item.strategy.humanSourceId = approvedHumanSourceId(humanId);
  const unrelatedFrame = { ...frame, sourceVideoMediaId: `media_${'9'.repeat(32)}`, sourceVideoContentHash: '9'.repeat(64), frameSha256: '9'.repeat(64) };
  const unrelatedSelection = { ...selection, sourceVideoMediaId: unrelatedFrame.sourceVideoMediaId, sourceVideoContentHash: unrelatedFrame.sourceVideoContentHash };
  const providerImageSource = { media: { id: `media_${'7'.repeat(32)}` }, stored: { buffer: Buffer.from('unrelated') } } as any;
  const creative = await renderPlannedCreative(item, {
    request, batchPlan: snapshot.batchPlan, referenceCatalog: [], selectedReferences: [], requestedSources: [], analysisSources: [],
    reserveLogoArea: false, brandLogo: null, providerImageSource,
    videoFrameSet: { ...frameSet, sourceVideoContentHash: unrelatedFrame.sourceVideoContentHash, frames: [unrelatedFrame] },
    generatedVideoFrameSelection: unrelatedSelection, storage,
  }, { creativeId: `creative_${'3'.repeat(32)}` });
  return { creative, item };
}

describe('render planned video provenance', () => {
  it('requests the explicit no-logo test without logo geometry or saved overlay provenance', async () => {
    const creative = await render(false, true, selection, false, undefined, undefined, false, true);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const args = mocks.generate.mock.calls[0][0];
    expect(args.logoGeometry).toBeUndefined(); expect(args.context).toContain('Do not render, invent or redraw any logo');
    expect(creative.generationProvenance).not.toHaveProperty('logoOverlaySource');
    expect(creative.planning).not.toHaveProperty('logoAnchor');
    expect(args.frames).toEqual([frame]);
  });
  it('attaches selected source pixels with exact source case wording and saves the draft binding', async () => {
    const creative = await render(false, true, selection, false, undefined, undefined, true);
    const passage = draftVideoPassage();
    expect(mocks.generate.mock.calls[0][0].copy.shortSupport).toBe(passage.exactText);
    expect(mocks.generate.mock.calls[0][0].frames).toEqual([frame]);
    expect(creative.planning?.draftSourceAssertion).toMatchObject({ exactText: passage.exactText, sourceMediaId: mediaId, verification: 'UNVERIFIED_SOURCE_ASSERTION', permission: 'REQUIRES_REVIEW' });
    expect(mocks.saveBatch.mock.calls[0][0][0].planning.draftSourceAssertion).toEqual(creative.planning?.draftSourceAssertion);
  });
  it('carries selected-video evidence alongside exact human frames into provider context and saved prompt', async () => {
    const sourceAnalysis = { version: 1, entries: [{ source: { role: 'TRA_VIDEO', mediaId, sha256: sourceHash },
      analyzer: { kind: 'REPRESENTATIVE_VIDEO_FRAMES', model: 'fixture', schemaVersion: 1, contextSha256: 'a'.repeat(64) },
      evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result: { kind: 'REPRESENTATIVE_VIDEO_FRAMES',
        analyzedFrames: [{ timestampMs: frame.timestampMs, frameSha256: frame.frameSha256 }],
        analysis: { summary: 'REFERENCE VIDEO CONSULTATION SCENE', visibleText: [], visualStructure: 'Person beside a desk',
          hookOrAngle: 'Explain the consultation', offerOrCta: '', styleNotes: '', preserve: [], avoid: [], unknowns: [],
          dominantCategory: 'customer-problems' } } }] } as const;
    mocks.generate.mockImplementationOnce(async args => ({ buffer: Buffer.from('image'), prompt: args.context,
      model: 'gpt-image-2.5-sunburst', routing, providerFrames: [{ ...frame, ...attachedFrames[0] }] }));
    const creative = await render(false, true, selection, false, sourceAnalysis as any);
    expect(mocks.generate.mock.calls[0][0].frames[0].sourceVideoMediaId).toBe(mediaId);
    expect(creative.generationProvenance!.imageGeneration.prompt).toContain('REFERENCE VIDEO CONSULTATION SCENE');
    expect(creative.generationProvenance!.imageGeneration.prompt).toContain(mediaId);
    expect(creative.generationProvenance!.requestedSources).toEqual([{ role: 'TRA_VIDEO', mediaId, sha256: sourceHash }]);
    expect(creative.videoFrameSelection!.sourceVideoMediaId).toBe(mediaId);
  });
  it.each([false, true])('blocks non-human video rendering without primary evidence (explicit=%s)', async explicit => {
    await expect(render(explicit, false)).rejects.toThrow(explicit ? 'explicitly selected TRA video frames' : 'selected video cannot be replaced');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.promptOnly).not.toHaveBeenCalled();
  });

  it('blocks a frozen graphic plan that ignores manual reviewed frames before provider work', async () => {
    await expect(render(false, false, selection, true)).rejects.toThrow('explicitly selected TRA video frames');
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.promptOnly).not.toHaveBeenCalled();
    expect(mocks.saveBatch).not.toHaveBeenCalled();
  });

  it('requires the supplied layout while attaching exact selected video human pixels', async () => {
    await expect(render(true, true, selection, false, undefined, 'IGNORED')).rejects.toThrow('supplied video layout reference');
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.promptOnly).not.toHaveBeenCalled();
    await render(true, true, selection, false, undefined, 'SELECTED');
    expect(mocks.generate.mock.calls[0][0].frames).toEqual([frame]);
    expect(mocks.generate.mock.calls[0][0].context).toContain('CENTERED_STACK');
    expect(mocks.saveBatch.mock.calls[0][0][0].planning.strategy.referenceSelection.layoutSource).toBe(referenceCandidate('4').referenceId);
  });

  it('saves automatic B3 provenance with exact selected-frame evidence', async () => {
    const creative = await render(false);
    expect(creative.generationProvenance!.attachedSource).toEqual({ type: 'TRA_VIDEO_FRAMES', mediaId,
      sourceSha256: sourceHash, selectionMode: 'AUTOMATIC', frames: attachedFrames });
    expect(creative.videoFrameSelection).toEqual(selection);
  });

  it('saves original approval and actual provider crop/hash as separate evidence', async () => {
    const sourceOverlay = { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 400,
      overlayDepthPermille: 390 } as const;
    const crop = { left: 0, top: 0, width: 100, height: 60 };
    mocks.generate.mockResolvedValueOnce({ buffer: Buffer.from('image'), prompt: 'prompt', model: 'gpt-image-2.5-sunburst',
      routing, providerFrames: [{ ...frame, sourceOverlay, providerPngSha256: '9'.repeat(64), crop }] });
    const creative = await render(false);
    expect(creative.generationProvenance!.attachedSource).toMatchObject({ frames: [{ timestampMs: 1200,
      approvedPngSha256: 'e'.repeat(64), providerPngSha256: '9'.repeat(64), sourceOverlay, crop }] });
    expect(creative.videoFrameSelection?.frames[0].approvedPngSha256).toBe('e'.repeat(64));
  });

  it('saves the actual group neighbor with source overlay, crop, and provider-pixel evidence', async () => {
    const actualFrameId = videoCandidateFrameId(sourceHash, 1200, 'd'.repeat(64));
    const selected = { ...selection, librarySha256: '1'.repeat(64), frames: [{ ...provenance[0],
      libraryFrameId: actualFrameId, representativeFrameId: frameId, candidateIndex: 7 }] };
    const sourceOverlay = { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 100,
      overlayDepthPermille: 80 } as const;
    const crop = { left: 0, top: 0, width: 100, height: 90 };
    mocks.generate.mockResolvedValueOnce({ buffer: Buffer.from('image'), prompt: 'prompt', model: 'gpt-image-2.5-sunburst',
      routing, providerFrames: [{ ...frame, sourceOverlay, providerPngSha256: '9'.repeat(64), crop }] });
    const creative = await render(true, true, selected);
    expect(creative.videoFrameSelection).toEqual(selected);
    expect(creative.generationProvenance!.attachedSource).toMatchObject({
      libraryId: selection.libraryId, librarySha256: '1'.repeat(64),
      frames: [{ libraryFrameId: actualFrameId, representativeFrameId: frameId, candidateIndex: 7,
        candidateFrameSha256: 'd'.repeat(64), sourceOverlay, crop, providerPngSha256: '9'.repeat(64) }],
    });
  });

  it('keeps explicit request video selection USER_SELECTED', async () => {
    expect((await render(true)).generationProvenance!.attachedSource).toMatchObject({ selectionMode: 'USER_SELECTED' });
  });

  it('resolves a generalized approved-human record and overrides unrelated request-wide sources', async () => {
    const { creative } = await renderCatalogHuman(false);
    expect(mocks.resolveHuman).toHaveBeenCalledWith(humanId);
    expect(mocks.generate.mock.calls[0][0].frames).toEqual([frame]);
    expect(creative.videoFrameSelection).toEqual(selection);
    expect(creative.generationProvenance!.attachedSource).toEqual({ type: 'TRA_VIDEO_FRAMES', mediaId,
      sourceSha256: sourceHash, selectionMode: 'USER_SELECTED', frames: attachedFrames });
    expect(creative.planning!.strategy.humanSourceId).toBe(approvedHumanSourceId(humanId));
    expect(creative.planning!.strategy).not.toHaveProperty('approvedHumanId');
  });

  it('keeps legacy approvedHumanId rendering on the same exact resolver lane', async () => {
    const { creative } = await renderCatalogHuman(true);
    expect(mocks.resolveHuman).toHaveBeenCalledWith(humanId);
    expect(mocks.generate.mock.calls[0][0].frames).toEqual([frame]);
    expect(creative.videoFrameSelection).toEqual(selection);
    expect(creative.planning!.strategy.approvedHumanId).toBe(humanId);
  });

  it('fails unsupported generalized source kinds before provider work', async () => {
    const request = portfolioRequest() as any;
    const snapshot = portfolioSnapshot(newCreativePortfolio(request));
    const item = structuredClone(snapshot.batchPlan.creatives[0]);
    item.strategy.execution.subjectSource = 'approved-tra-human';
    item.strategy.humanSourceId = `video-frame:${'4'.repeat(64)}`;
    await expect(renderPlannedCreative(item, {
      request, batchPlan: snapshot.batchPlan, referenceCatalog: [], selectedReferences: [], requestedSources: [], analysisSources: [],
      reserveLogoArea: false, brandLogo: null, providerImageSource: undefined, videoFrameSet: null, storage,
    }, { creativeId: `creative_${'4'.repeat(32)}` })).rejects.toThrow('Unsupported or invalid human source ID');
    expect(mocks.resolveHuman).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it.each([
    ['overlong modern copy', (item: any) => {
      item.copy.primaryText = 'x'.repeat(1001);
      item.adCopy.primaryText = 'x'.repeat(1001);
    }],
    ['partial modern copy', (item: any) => { delete item.imageCopy; }],
  ])('rejects restored %s before provider or persistence work, including explicit retry', async (_name, corrupt) => {
    const request = portfolioRequest() as any;
    const snapshot = portfolioSnapshot(newCreativePortfolio(request));
    const item = structuredClone(snapshot.batchPlan.creatives[0]);
    corrupt(item);
    const renderInvalid = () => renderPlannedCreative(item, {
      request, batchPlan: snapshot.batchPlan, referenceCatalog: [], selectedReferences: [], requestedSources: [], analysisSources: [],
      reserveLogoArea: false, brandLogo: null, providerImageSource: undefined, videoFrameSet: frameSet, storage,
    }, { creativeId: `creative_${'4'.repeat(32)}` });

    await expect(renderInvalid()).rejects.toThrow('invalid separated ad/image copy contract');
    await expect(renderInvalid()).rejects.toThrow('invalid separated ad/image copy contract');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(storage.saveImage).not.toHaveBeenCalled();
    expect(mocks.saveBatch).not.toHaveBeenCalled();
  });
});

it('saves manual review selection and exact candidate/provider provenance', async () => {
  const selected = { ...selection, librarySha256: '1'.repeat(64), frames: [{ ...provenance[0],
    libraryFrameId: videoCandidateFrameId(sourceHash, 1200, 'd'.repeat(64)), representativeFrameId: frameId, candidateIndex: 7 }] };
  const creative = await render(false, true, selected, true);
  expect(mocks.generate.mock.calls[0][0].frames).toEqual([frame]);
  expect(creative.videoFrameSelection).toEqual(selected);
  expect(creative.planning!.strategy.humanSourceId).toBeUndefined(); expect(mocks.resolveHuman).not.toHaveBeenCalled();
  expect(mocks.saveBatch.mock.calls[0][0][0].generationProvenance.attachedSource).toMatchObject({ selectionMode: 'USER_SELECTED',
    libraryId: selected.libraryId, librarySha256: selected.librarySha256, frames: [{ candidateIndex: 7,
      representativeFrameId: frameId, candidateFrameSha256: 'd'.repeat(64), approvedPngSha256: 'e'.repeat(64), providerPngSha256: 'e'.repeat(64) }] });
});

it('rejects an automatic or unknown frame at the final manual render boundary before image work', async () => {
  await expect(render(false, true, selection, true)).rejects.toThrow('closed-pool');
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.promptOnly).not.toHaveBeenCalled(); expect(mocks.saveBatch).not.toHaveBeenCalled();
});

describe('rendering explicit people mix', () => {
  const evidence = { version: 1, entries: [{ source: { role: 'TRA_VIDEO', mediaId, sha256: sourceHash },
    analyzer: { kind: 'REPRESENTATIVE_VIDEO_FRAMES', model: 'fixture', schemaVersion: 1, contextSha256: 'a'.repeat(64) },
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result: { kind: 'REPRESENTATIVE_VIDEO_FRAMES',
      analyzedFrames: [{ timestampMs: 1200, frameSha256: 'e'.repeat(64) }],
      analysis: { summary: 'TRA source direction', visibleHuman: true, visibleText: [], visualStructure: 'Person',
        hookOrAngle: 'Consultation', offerOrCta: '', styleNotes: '', preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems' } } }] } as any;
  it.each([false, true])('renders zero-percent graphics without attaching video people (explicit=%s)', async explicit => {
    const creative = await render(explicit, false, selection, false, evidence, undefined, false, false, 0);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.promptOnly).toHaveBeenCalledTimes(1);
    expect(mocks.promptOnly.mock.calls[0][0].context).toContain('must depict no person');
    expect(creative.generationProvenance?.attachedSource).toBeNull();
  });
  it('allows a graphic slot in a manually reviewed pool without attaching its frames', async () => {
    await render(false, false, selection, true, evidence, undefined, false, false, 0);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.resolveHuman).not.toHaveBeenCalled();
    expect(mocks.promptOnly).toHaveBeenCalledTimes(1);
  });
  it('blocks an attempted graphic substitution for a required human slot before paid work', async () => {
    await expect(render(false, false, selection, false, evidence, undefined, false, false, 100)).rejects.toThrow('Ads with people');
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.promptOnly).not.toHaveBeenCalled();
  });
});
