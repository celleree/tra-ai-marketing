import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalVideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { parseGenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { parseReviewSelectionChoices, reviewSourceSha256, usesAutomaticReviewFrames, type ReviewSelectionChoices } from '@/lib/video/review-selection';

const mocks = vi.hoisted(() => ({ current: vi.fn(), resolve: vi.fn(), library: vi.fn(), preparation: vi.fn(), proofs: vi.fn(),
  mutateProof: vi.fn(), access: vi.fn(), storage: undefined as unknown }));
vi.mock('@/lib/video/intelligence-storage', async original => ({ ...await original<typeof import('@/lib/video/intelligence-storage')>(),
  getVideoIntelligenceStorage: () => mocks.storage }));
vi.mock('@/lib/video/intelligence-service', async original => ({ ...await original<typeof import('@/lib/video/intelligence-service')>(),
  readVideoIntelligenceSource: mocks.current, resolveExistingVideoIntelligenceJob: mocks.resolve }));
vi.mock('@/lib/video/intelligence-finalization-runner', () => ({ loadVideoIntelligenceLibrary: mocks.library }));
vi.mock('@/lib/video/intelligence-preparation-loader', () => ({ loadVideoIntelligencePreparation: mocks.preparation }));
vi.mock('@/lib/proof/storage', () => ({ listProofRecords: mocks.proofs, updateProofRecord: mocks.mutateProof }));
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess: mocks.access }));
import { loadVideoReviewDraft, saveVideoReviewDraft } from '@/lib/video/review-selection-store';
import * as route from '@/app/api/video/review-selection/route';

import { locator, video, frame, segments, library, manifest, review, caseStudy, profile, proofChoice, claims, choices, blank } from '@/tests/fixtures/video-review-selection';
let root: string;
beforeEach(async () => {
  vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No provider calls permitted.'); }));
  root = await mkdtemp(path.join(tmpdir(), 'tra-review-')); mocks.storage = new LocalVideoIntelligenceStorage(root);
  mocks.current.mockResolvedValue({ locator }); mocks.resolve.mockResolvedValue({ identity: { sourceVideoMediaId: locator.sourceVideoMediaId,
    sourceVideoContentHash: locator.sourceVideoContentHash, analyzerFingerprint: { sha256: locator.analyzerFingerprintSha256 } },
  job: { phase: 'COMPLETE', result: { sha256: video.librarySha256 }, preparation: { manifestKey: 'manifest', manifestSha256: video.preparationSha256 } } });
  mocks.library.mockResolvedValue(library); mocks.preparation.mockResolvedValue({ manifest });
  mocks.proofs.mockResolvedValue([review, caseStudy]); mocks.access.mockResolvedValue(null);
});
afterEach(async () => { expect(fetch).not.toHaveBeenCalled(); expect(mocks.mutateProof).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const save = (value = choices()) => saveVideoReviewDraft({ id: null, expectedRevision: null, choices: value });

describe('persisted draft frame and claim choices', () => {
  it('round trips representative and neighboring candidates with every claim source and supporting context', async () => {
    const saved = await save(); const loaded = await loadVideoReviewDraft(saved.draft.id);
    expect(loaded).toEqual(saved); expect(saved.draft.choices.frames).toEqual([frame(0), frame(1)]);
    expect(saved.draft.claimSnapshots.map(item => item.wording)).toEqual([segments.map(item => item.text).join(' '), 'Free consultation',
      review.originalReviewText, caseStudy.approvedClaimWording, 'Free consultation.']);
    expect(saved.draft.claimSnapshots[1].context).toMatchObject({ evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
      observation: { uncertainties: ['Small print unclear.'] } });
    expect(saved.draft.claimSnapshots[2].context).toEqual({ type: 'PROOF', record: review });
    expect(saved.draft.claimSnapshots[3].context).toMatchObject({ record: { usageRestrictions: 'Do not generalize.', requiredDisclaimer: 'Results vary.' } });
    expect(saved.draft.claimSnapshots[4].context).toMatchObject({ fieldText: profile.knowledgeBase.servicesOffers, guardrails: profile.guardrails });
    expect(parseGenerateVideoFrameSelection(saved.draft)).toBeNull();
    expect(JSON.stringify(saved.draft)).not.toMatch(/thumbnail|sourceOverlays|approvedPngSha256|providerPngSha256/);
  });
  it('keeps a standalone video claim without creating or linking Proof', async () => {
    const saved = await save({ ...blank(), video, claims: [{ type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 }] });
    expect(saved.draft.claimSnapshots[0].reference.type).toBe('VIDEO_TRANSCRIPT'); expect(mocks.proofs).not.toHaveBeenCalled();
    expect(saved.transcriptContext?.segments).toEqual(segments);
    expect((await loadVideoReviewDraft(saved.draft.id)).transcriptContext?.segments[1].text).toBe('Eligibility and fees vary by state.');
  });
  it('distinguishes untouched choices from deselection and keeps automatic selection available', async () => {
    const untouched = await save(blank()); expect(usesAutomaticReviewFrames(untouched.draft.choices)).toBe(true);
    const selected = await save(); expect(usesAutomaticReviewFrames(selected.draft.choices)).toBe(false);
    const cleared = await saveVideoReviewDraft({ id: selected.draft.id, expectedRevision: selected.revision,
      choices: { ...blank(), frames: [], claims: [] } });
    expect((await loadVideoReviewDraft(cleared.draft.id)).draft.choices).toEqual({ ...blank(), frames: [], claims: [] });
    expect(cleared.draft.claimSnapshots).toEqual([]); expect(usesAutomaticReviewFrames(cleared.draft.choices)).toBe(true);
    expect(untouched.draft.choices.frames).toBeNull();
  });
  it.each([['duplicate', [frame(0), frame(0)]]])
    ('rejects %s frames', (_name, frames) => expect(() => parseReviewSelectionChoices({ ...choices(), frames })).toThrow('distinct valid source frames'));
  it('round trips twelve exact manual candidates with saved revisions and preserves per-creative attachment limits', async () => {
    const frames = Array.from({ length: 12 }, (_, index) => frame(index)), indexes = frames.map(item => item.candidateIndex);
    mocks.library.mockResolvedValue({ ...library, candidates: frames,
      representativeFrames: [{ ...library.representativeFrames[0], candidateIndexes: indexes }] });
    mocks.preparation.mockResolvedValue({ manifest: { candidates: frames, groups: [{ representativeIndex: 0, candidateIndexes: indexes }] } });
    const saved = await save({ ...choices(), frames });
    expect((await loadVideoReviewDraft(saved.draft.id)).draft.choices.frames).toEqual(frames);
    const edited = await saveVideoReviewDraft({ id: saved.draft.id, expectedRevision: saved.revision, choices: { ...choices(), frames: frames.slice(1) } });
    expect(edited.revision).not.toBe(saved.revision);
    expect((await loadVideoReviewDraft(saved.draft.id)).draft.choices.frames).toEqual(frames.slice(1));
    expect(parseGenerateVideoFrameSelection({ version: 2, libraryId: video.libraryId, sourceVideoContentHash: locator.sourceVideoContentHash,
      frameIds: frames.slice(0, 4).map(item => item.frameId), sourceOverlays: frames.slice(0, 4).map(() => ({ version: 2, status: 'CLEAN' })) })).toBeNull();
  });
  it('rejects an oversized draft explicitly without changing the saved revision or choices', async () => {
    const saved = await save();
    mocks.library.mockResolvedValue({ ...library, transcript: { ...library.transcript,
      segments: segments.map(segment => ({ ...segment, text: 'x'.repeat(1024 * 1024) })) } });
    await expect(saveVideoReviewDraft({ id: saved.draft.id, expectedRevision: saved.revision, choices: choices() })).rejects.toThrow('size limit');
    mocks.library.mockResolvedValue(library);
    expect(await loadVideoReviewDraft(saved.draft.id)).toEqual(saved);
  });
  it('rejects duplicate claims and accepts specific case-study facts', async () => {
    expect(() => parseReviewSelectionChoices({ ...choices(), claims: [claims()[0], claims()[0]] })).toThrow('distinct');
    const reference = { ...proofChoice(caseStudy as never, 'verifiedFacts'), field: 'verifiedFacts' as const, factIndex: 0,
      end: caseStudy.verifiedFacts[0].length };
    expect((await save({ ...blank(), claims: [reference] })).draft.claimSnapshots[0].wording).toBe(caseStudy.verifiedFacts[0]);
  });
  it.each([
    ['source hash drift', () => mocks.current.mockResolvedValue({ locator: { ...locator, sourceVideoContentHash: '9'.repeat(64) } })],
    ['missing video', () => mocks.current.mockRejectedValue(new Error('Source missing'))],
    ['missing analysis artifact', () => mocks.library.mockRejectedValue(new Error('Library artifact missing'))],
    ['stale library', () => mocks.resolve.mockResolvedValue({ job: { phase: 'COMPLETE', result: { sha256: '9'.repeat(64) }, preparation: { manifestSha256: video.preparationSha256 } } })],
    ['stale preparation', () => mocks.resolve.mockResolvedValue({ job: { phase: 'COMPLETE', result: { sha256: video.librarySha256 }, preparation: { manifestSha256: '9'.repeat(64) } } })],
    ['missing Proof', () => mocks.proofs.mockResolvedValue([])],
    ['changed Proof', () => mocks.proofs.mockResolvedValue([{ ...review, originalReviewText: 'Different wording' }, caseStudy])],
  ])('rejects %s on save and preserves original choices while surfacing it on load', async (_name, change) => {
    const saved = await save(); change();
    await expect(save()).rejects.toMatchObject({ status: 409 });
    const loaded = await loadVideoReviewDraft(saved.draft.id); expect(loaded.issues.length).toBeGreaterThan(0); expect(loaded.draft).toEqual(saved.draft);
  });
  it.each([
    ['group mismatch', () => ({ ...choices(), frames: [{ ...frame(1), representativeFrameId: `video-frame:${'9'.repeat(64)}` }] })],
    ['transcript range', () => ({ ...blank(), video, claims: [{ type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 10 }] })],
    ['neighbor OCR', () => ({ ...blank(), video, claims: [{ type: 'VIDEO_ON_SCREEN', frame: frame(1), statementIndex: 0 }] })],
    ['profile hash', () => ({ ...choices(), companyProfile: { knowledgeBase: { servicesOffers: 'Different statement.' } } })],
    ['profile field', () => ({ ...blank(), companyProfile: {}, claims: [{ ...claims()[4], profileSha256: reviewSourceSha256({}) }] })],
    ['Proof type', () => ({ ...blank(), claims: [{ ...proofChoice(), proofType: 'case-study' }] })],
    ['Proof field', () => ({ ...blank(), claims: [{ ...proofChoice(), field: 'approvedClaimWording' }] })],
    ['text range', () => ({ ...blank(), claims: [{ ...proofChoice(), end: 10_000 }] })],
  ])('rejects mismatched %s references', async (_name, input) => await expect(save(input() as ReviewSelectionChoices)).rejects.toMatchObject({ status: 409 }));
  it('rejects stale writes and concurrent overwrites without losing the winning choices', async () => {
    const first = await save(blank());
    const input = { id: first.draft.id, expectedRevision: first.revision, choices: { ...blank(), frames: [], claims: [] } };
    const results = await Promise.allSettled([saveVideoReviewDraft(input), saveVideoReviewDraft(input)]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
    await expect(saveVideoReviewDraft(input)).rejects.toMatchObject({ status: 409 });
    expect((await loadVideoReviewDraft(first.draft.id)).draft.choices.frames).toEqual([]);
  });
  it('reports a changed browser profile without substituting its new text', async () => {
    const saved = await save(); const loaded = await loadVideoReviewDraft(saved.draft.id, {}, reviewSourceSha256({}));
    expect(loaded.profileSource).toBe('OPERATOR_SNAPSHOT'); expect(loaded.issues).toContainEqual(expect.objectContaining({ source: 'COMPANY_PROFILE' }));
    expect(loaded.draft).toEqual(saved.draft);
  });
  it('retains draft choices and revision during a Proof read outage and allows deselection', async () => {
    const saved = await save(); mocks.proofs.mockRejectedValue(new Error('Proof index read unavailable'));
    const response = await route.GET(new Request(`http://localhost/api/video/review-selection?id=${saved.draft.id}`));
    expect(response.status).toBe(200); const loaded = await response.json();
    expect(loaded.draft).toEqual(saved.draft); expect(loaded.revision).toBe(saved.revision);
    expect(loaded.issues).toEqual([2, 3].map(index => ({ source: 'CLAIM', index,
      message: 'Selected Proof source is unavailable: Proof index read unavailable' })));
    await expect(save()).rejects.toThrow('Proof index read unavailable');
    const cleared = await saveVideoReviewDraft({ id: saved.draft.id, expectedRevision: loaded.revision,
      choices: { ...saved.draft.choices, claims: [] } });
    expect((await loadVideoReviewDraft(cleared.draft.id)).issues).toEqual([]);
    expect(cleared.draft.claimSnapshots).toEqual([]);
  });
});

describe('review selection API', () => {
  const request = (body: unknown) => new Request('http://localhost/api/video/review-selection', { method: 'POST', body: JSON.stringify(body) });
  it('saves and loads choices using a public revision and private no-store responses', async () => {
    const response = await route.POST(request({ id: null, expectedRevision: null, choices: blank() }));
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const saved = await response.json();
    expect(await (await route.GET(new Request(`http://localhost/api/video/review-selection?id=${saved.draft.id}`))).json()).toEqual(saved);
    expect(mocks.current).not.toHaveBeenCalled();
  });
  it('requires operator access before source or storage work and rejects invalid requests', async () => {
    mocks.access.mockResolvedValue(new Response('Denied', { status: 401 }));
    expect((await route.POST(request({}))).status).toBe(401);
    expect((await route.GET(new Request('http://localhost/api/video/review-selection'))).status).toBe(401);
    expect(mocks.current).not.toHaveBeenCalled(); mocks.access.mockResolvedValue(null);
    expect((await route.POST(request({ choices: blank() }))).status).toBe(400);
    expect((await route.GET(new Request(`http://localhost/api/video/review-selection?id=review_${'8'.repeat(32)}`))).status).toBe(404);
  });
});
