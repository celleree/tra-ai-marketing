import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalVideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { locator, video, frame, segments, library, manifest, review, caseStudy, profile, choices, blank } from '@/tests/fixtures/video-review-selection';
import { reviewSourceSha256 } from '@/lib/video/review-selection';
const mocks = vi.hoisted(() => ({ current: vi.fn(), resolve: vi.fn(), library: vi.fn(), preparation: vi.fn(), proofs: vi.fn() }));
vi.mock('@/lib/video/intelligence-service', () => ({ readVideoIntelligenceSource: mocks.current, resolveExistingVideoIntelligenceJob: mocks.resolve }));
vi.mock('@/lib/video/intelligence-finalization-runner', () => ({ loadVideoIntelligenceLibrary: mocks.library }));
vi.mock('@/lib/video/intelligence-preparation-loader', () => ({ loadVideoIntelligencePreparation: mocks.preparation }));
vi.mock('@/lib/proof/storage', () => ({ listProofRecords: mocks.proofs }));
import { saveVideoReviewDraft, loadVideoReviewDraft } from '@/lib/video/review-selection-store';
import { resolveVideoReviewHandoff, MAX_REVIEW_HANDOFF_BYTES, MAX_OPERATOR_SOURCE_GUIDANCE_BYTES } from '@/lib/creatives/review-handoff';
let root: string, storage: LocalVideoIntelligenceStorage;
beforeEach(async () => {
  vi.resetAllMocks(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Provider calls forbidden.'); }));
  root = await mkdtemp(path.join(tmpdir(), 'tra-handoff-')); storage = new LocalVideoIntelligenceStorage(root);
  mocks.current.mockResolvedValue({ locator }); mocks.resolve.mockResolvedValue({ identity: { sourceVideoMediaId: locator.sourceVideoMediaId,
    sourceVideoContentHash: locator.sourceVideoContentHash, analyzerFingerprint: { sha256: locator.analyzerFingerprintSha256 } }, job: { phase: 'COMPLETE',
    result: { sha256: video.librarySha256 }, preparation: { manifestKey: 'manifest', manifestSha256: video.preparationSha256 } } });
  mocks.library.mockResolvedValue(structuredClone(library)); mocks.preparation.mockResolvedValue({ manifest });
  mocks.proofs.mockResolvedValue([review, caseStudy]);
});
afterEach(async () => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
const save = (value = choices()) => saveVideoReviewDraft({ id: null, expectedRevision: null, choices: value }, { storage });
const input = (saved: Awaited<ReturnType<typeof save>>) => ({ draftId: saved.draft.id, revision: saved.revision,
  traVideoMediaIds: [locator.sourceVideoMediaId], currentCompanyProfile: profile });

describe('server-authoritative review handoff foundation', () => {
  it('preserves exact choices, all source snapshots, qualifications and frozen profile as guidance only', async () => {
    const saved = await save(), result = await resolveVideoReviewHandoff(input(saved), { storage });
    expect(result).toMatchObject({ version: 1, artifactType: 'VIDEO_REVIEW_HANDOFF', draftId: saved.draft.id, revision: saved.revision,
      choices: saved.draft.choices, claimSnapshots: saved.draft.claimSnapshots });
    const guidance = result.operatorSelectedSourceGuidance;
    expect(guidance).toMatchObject({ usage: 'DRAFT_CREATIVE_GUIDANCE_ONLY', grantsAdvertisingApproval: false, providerEligible: false,
      video, frameMode: 'MANUAL_CLOSED_POOL', companyProfile: profile, statements: saved.draft.claimSnapshots });
    expect(guidance.frames?.map(item => item.binding)).toEqual([frame(0), frame(1)]);
    expect(guidance.frames?.[0]).toMatchObject({ observationIsExactFrame: true, observation: library.representativeFrames[0].observation });
    expect(guidance.frames?.[1]).toMatchObject({ observationSourceFrameId: frame(0).frameId, observationIsExactFrame: false });
    expect(guidance.transcriptContext?.segments).toEqual(segments);
    expect(guidance.statements?.[1].context).toMatchObject({ observation: { uncertainties: ['Small print unclear.'] } });
    expect(guidance.statements?.[2].context).toEqual({ type: 'PROOF', record: review });
    expect(guidance.statements?.[3].context).toMatchObject({ record: { usageRestrictions: 'Do not generalize.', requiredDisclaimer: 'Results vary.' } });
    expect(Object.isFrozen(result.choices.frames?.[0])).toBe(true);
    expect(await loadVideoReviewDraft(saved.draft.id, { storage })).toEqual(saved);
  });
  it('rejects an outdated revision, then accepts only the current saved revision', async () => {
    const saved = await save();
    const current = await saveVideoReviewDraft({ id: saved.draft.id, expectedRevision: saved.revision, choices: { ...choices(), frames: [] } }, { storage });
    await expect(resolveVideoReviewHandoff(input(saved), { storage })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('changed') });
    expect((await resolveVideoReviewHandoff(input(current), { storage })).choices.frames).toEqual([]);
  });
  it('requires the exact reviewed video in a bounded TRA_VIDEO inventory', async () => {
    const saved = await save();
    await expect(resolveVideoReviewHandoff({ ...input(saved), traVideoMediaIds: [`media_${'9'.repeat(32)}`] }, { storage })).rejects.toMatchObject({ status: 409 });
    await expect(resolveVideoReviewHandoff({ ...input(saved), traVideoMediaIds: Array(11).fill(locator.sourceVideoMediaId) }, { storage })).rejects.toMatchObject({ status: 400 });
  });
  it.each(['replaced video', 'missing library', 'missing Proof', 'Proof read outage'])('fails closed through existing source validation: %s', async failure => {
    const saved = await save();
    if (failure === 'replaced video') mocks.current.mockResolvedValue({ locator: { ...locator, sourceVideoContentHash: '9'.repeat(64) } });
    if (failure === 'missing library') mocks.library.mockRejectedValue(new Error('Frozen library missing'));
    if (failure === 'missing Proof') mocks.proofs.mockResolvedValue([]);
    if (failure === 'Proof read outage') mocks.proofs.mockRejectedValue(new Error('Proof read unavailable'));
    await expect(resolveVideoReviewHandoff(input(saved), { storage })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('sources require attention') });
  });
  it('compares canonical profile hashes without substituting submitted fields', async () => {
    const saved = await save();
    expect((await resolveVideoReviewHandoff({ ...input(saved), currentCompanyProfile: { guardrails: profile.guardrails,
      knowledgeBase: profile.knowledgeBase } }, { storage })).choices.companyProfile).toEqual(profile);
    await expect(resolveVideoReviewHandoff({ ...input(saved), currentCompanyProfile: {} }, { storage })).rejects.toMatchObject({ status: 409 });
    await expect(resolveVideoReviewHandoff({ ...input(saved), currentCompanyProfile: null }, { storage })).rejects.toMatchObject({ status: 409 });
    expect((await resolveVideoReviewHandoff({ ...input(saved), currentCompanyProfile: undefined }, { storage })).choices.companyProfile).toEqual(profile);
  });
  it.each([null, []])('preserves zero-frame/claim state %j as automatic', async state => {
    const saved = await save({ ...blank(), frames: state, claims: state });
    const result = await resolveVideoReviewHandoff({ ...input(saved), traVideoMediaIds: [] }, { storage });
    expect(result.choices.frames).toEqual(state); expect(result.choices.claims).toEqual(state);
    expect(result.operatorSelectedSourceGuidance).toMatchObject({ frames: state, statements: state, frameMode: 'AUTOMATIC', companyProfile: null });
    expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.proofs).not.toHaveBeenCalled();
  });
  it('bounds surrounding transcript segments while preserving selected wording and timestamped qualifications', async () => {
    const transcriptSegments = Array.from({ length: 7 }, (_, segmentIndex) => ({ segmentIndex, startMs: segmentIndex * 1000,
      endMs: (segmentIndex + 1) * 1000, text: segmentIndex === 3 ? 'Exact selected wording.' : `Qualification ${segmentIndex}.` }));
    mocks.library.mockResolvedValue({ ...library, transcript: { ...library.transcript, segments: transcriptSegments } });
    const saved = await save({ ...blank(), video, claims: [{ type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 3, endSegmentIndex: 3 }] });
    const result = await resolveVideoReviewHandoff(input(saved), { storage });
    expect(result.claimSnapshots[0].wording).toBe('Exact selected wording.');
    expect(result.operatorSelectedSourceGuidance.transcriptContext).toMatchObject({ segments: transcriptSegments.slice(2, 5),
      surroundingSegmentRadius: 1, totalSourceSegments: 7, omittedSegments: 4 });
  });
  it('preserves long selected wording and includes transcript context for on-screen-only selections', async () => {
    const text = 'Exact source. '.repeat(400);
    mocks.library.mockResolvedValue({ ...library, transcript: { ...library.transcript, segments: [{ ...segments[0], text }, segments[1]] } });
    const saved = await save({ ...blank(), video, claims: [{ type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 }] });
    expect((await resolveVideoReviewHandoff(input(saved), { storage })).operatorSelectedSourceGuidance.statements?.[0].wording).toBe(text);
    const visible = await save({ ...blank(), video, claims: [{ type: 'VIDEO_ON_SCREEN', frame: frame(0), statementIndex: 0 }] });
    expect((await resolveVideoReviewHandoff(input(visible), { storage })).operatorSelectedSourceGuidance.transcriptContext?.segments)
      .toEqual([{ ...segments[0], text }, segments[1]]);
  });
  it.each([{ draftId: 'not-a-review' }, { revision: '' }, { revision: 'x'.repeat(1025) }])('rejects invalid references before storage/source work: %j', async invalid => {
    await expect(resolveVideoReviewHandoff({ draftId: `review_${'a'.repeat(32)}`, revision: 'etag', traVideoMediaIds: [], ...invalid }, { storage }))
      .rejects.toMatchObject({ status: 400 });
    expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.proofs).not.toHaveBeenCalled();
  });
  it.each([[25_000, 'Selected source guidance', MAX_OPERATOR_SOURCE_GUIDANCE_BYTES],
    [60_000, 'Review handoff', MAX_REVIEW_HANDOFF_BYTES]])('rejects oversized selected material (%i characters) without truncation', async (length, label, limit) => {
    const text = 'é'.repeat(Number(length));
    mocks.library.mockResolvedValue({ ...library, transcript: { ...library.transcript, segments: [{ ...segments[0], text }] } });
    const saved = await save({ ...blank(), video, claims: [{ type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 }] });
    await expect(resolveVideoReviewHandoff(input(saved), { storage })).rejects.toMatchObject({ status: 400,
      message: expect.stringContaining(`${label} exceeds ${limit} bytes`) });
    expect((await loadVideoReviewDraft(saved.draft.id, { storage })).draft.claimSnapshots[0].wording).toBe(text);
  });
  it('hashes the complete detached snapshot deterministically, including projection and exact revision', async () => {
    const saved = await save(), first = await resolveVideoReviewHandoff(input(saved), { storage });
    expect(await resolveVideoReviewHandoff(input(saved), { storage })).toEqual(first);
    const { handoffSha256, ...value } = first; expect(handoffSha256).toBe(reviewSourceSha256(value));
    saved.draft.choices.frames!.reverse(); expect(first.choices.frames).toEqual([frame(0), frame(1)]);
    const changed = await saveVideoReviewDraft({ id: saved.draft.id, expectedRevision: saved.revision, choices: saved.draft.choices }, { storage });
    expect((await resolveVideoReviewHandoff(input(changed), { storage })).handoffSha256).not.toBe(handoffSha256);
  });
});
