import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => () => void>,
  profile: { knowledgeBase: { servicesOffers: 'Battery backup included.' } } }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (value: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = value;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = next; }]; }, useEffect: (effect: () => () => void) => { hooks.effects.push(effect); } }));
vi.mock('@/lib/company/creative-context', async original => ({ ...await original<object>(), readStoredRuntimeCompanyProfile: () => hooks.profile }));
import { VideoReviewStatements, toggleReviewClaim } from '@/components/creative-generator/video-review-statements';
import { discoverReviewStatements } from '@/lib/video/review-statement-discovery';
import type { ReviewSource } from '@/components/creative-generator/video-review-panel';
import type { useVideoReviewDraft } from '@/components/creative-generator/use-video-review-draft';
const review = { video: { locator: { sourceVideoMediaId: 'media' } }, library: { transcript: { segments: [
  { segmentIndex: 0, startMs: 12000, endMs: 16000, text: 'We cut our electric bill by about 40%.' },
  { segmentIndex: 1, startMs: 16000, endMs: 18000, text: 'Results vary by home and usage.' }] } }, onScreenStatements: [
    { reference: { type: 'VIDEO_ON_SCREEN', frame: { timestampMs: 4000, candidateIndex: 0, frameId: 'observed' }, statementIndex: 0 },
      wording: 'On-screen offer.', context: { type: 'VIDEO_ON_SCREEN', observation: { uncertainties: ['Small print unclear.'] } } }] } as unknown as NonNullable<ReviewSource['review']>;
const timestamp = '2026-10-01T00:00:00.000Z';
const sources = await discoverReviewStatements(hooks.profile, { proofs: async () => [
  { id: `proof_${'a'.repeat(32)}`, type: 'review', status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp, tags: [], originalReviewText: 'Best decision we made for the house.' },
  { id: `proof_${'b'.repeat(32)}`, type: 'case-study', status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp, tags: [], title: 'Smith Residence',
    verifiedFacts: ['Installation was completed in two weeks.'], approvedClaimWording: '', sourceNote: 'Project report', requiredDisclaimer: 'Results vary.', usageRestrictions: 'Residential only.' }] });
let draft: ReturnType<typeof useVideoReviewDraft>, request: ReturnType<typeof vi.fn<typeof fetch>>, cleanup: (() => void) | undefined;
const render = (disabled = false) => { hooks.cursor = 0; hooks.effects = []; return VideoReviewStatements({ review, draft, disabled }); };
const nodes = (tree: unknown): ReactElement<Record<string, unknown>>[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
  : 'props' in tree ? [tree as ReactElement<Record<string, unknown>>, ...nodes((tree as ReactElement<{ children?: unknown }>).props.children)] : [];
beforeEach(() => { hooks.values = []; cleanup = undefined;
  draft = { state: { choices: { video: review.video, frames: [], claims: null, companyProfile: null }, saved: null },
    update: vi.fn(async (_video, change) => { draft.state.choices = change(draft.state.choices!); }) } as unknown as ReturnType<typeof useVideoReviewDraft>;
  request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(sources)); vi.stubGlobal('fetch', request); });
afterEach(() => { cleanup?.(); expect(request.mock.calls.every(([url, init]) => url === '/api/video/review-sources' && init?.method === 'POST')).toBe(true); vi.unstubAllGlobals(); });
const load = async () => { render(); cleanup = hooks.effects[0](); await vi.waitFor(() => expect(hooks.values[0]).toEqual(sources)); };
describe('exact source statements and progressive context', () => {
  it('reopens and selects the frozen Profile snapshot even when current browser context has changed', async () => {
    const frozen = { knowledgeBase: { servicesOffers: '  Saved exact offer.  ' } }; draft.state.choices!.companyProfile = frozen;
    const savedSources = await discoverReviewStatements(frozen, { proofs: async () => [] });
    request.mockResolvedValueOnce(Response.json(savedSources)); render(); cleanup = hooks.effects[0]();
    await vi.waitFor(() => expect(hooks.values[0]).toEqual(savedSources));
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ companyProfile: frozen });
    (nodes(render()).filter(node => node.type === 'input').at(-1)!.props.onChange as () => void)();
    expect(draft.state.choices!.companyProfile).toEqual(frozen);
    expect(draft.state.choices!.claims).toEqual([savedSources.statements[0].reference]);
    expect(renderToStaticMarkup(render())).toContain('Saved exact offer.'); expect(renderToStaticMarkup(render())).toContain('Using saved Company Profile context.');
  });
  it('renders all five families with exact wording, timestamps, qualifications and collapsed context/transcript', async () => {
    await load(); const html = renderToStaticMarkup(render());
    for (const text of ['We cut our electric bill by about 40%.', '00:12–00:16', 'Video transcript', 'On-screen offer.', 'On-screen video text',
      'Best decision we made for the house.', 'Customer Review', 'Case Study · Smith Residence', 'Installation was completed in two weeks.',
      'Battery backup included.', 'Company Profile', 'Results vary.', 'Residential only.', 'View context', 'Transcript']) expect(html).toContain(text);
    expect(html).not.toContain('<details open'); expect(request).toHaveBeenCalledTimes(1);
  });
  it('selects/deselects exact references from each family and attaches the matching Profile snapshot', async () => {
    await load(); const checks = nodes(render()).filter(node => node.type === 'input');
    for (const check of checks) (check.props.onChange as () => void)();
    expect(draft.state.choices!.claims!.map(reference => reference.type)).toEqual(['VIDEO_TRANSCRIPT', 'VIDEO_TRANSCRIPT', 'VIDEO_ON_SCREEN', 'PROOF', 'PROOF', 'COMPANY_PROFILE']);
    expect(draft.state.choices!.companyProfile).toEqual(hooks.profile);
    for (const check of nodes(render()).filter(node => node.type === 'input')) (check.props.onChange as () => void)();
    expect(draft.state.choices!.claims).toEqual([]); expect(request).toHaveBeenCalledTimes(1);
  });
  it('restores exact saved excerpts, never marks old-video claims as selected on a different video, and honors save/generation disabling', async () => {
    await load(); const selected = sources.statements[0]; draft.state.choices!.claims = [selected.reference, { type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 }];
    draft.state.choices!.video = { ...review.video, libraryId: 'another library' };
    draft.state.saved = { draft: { claimSnapshots: [{ ...selected, wording: 'Saved exact excerpt.', reference: { ...selected.reference, end: 5 } }] } } as never;
    const checks = nodes(render()).filter(node => node.type === 'input'); expect(checks[0].props.checked).toBe(false); expect(checks[3].props.checked).toBe(true);
    expect(renderToStaticMarkup(render())).toContain('Saved exact excerpt.');
    expect(nodes(render(true)).filter(node => node.type === 'input').every(node => node.props.disabled)).toBe(true);
    const references = Array.from({ length: 50 }, (_, index) => ({ type: 'VIDEO_TRANSCRIPT' as const, startSegmentIndex: index, endSegmentIndex: index }));
    expect(toggleReviewClaim(references, selected.reference)).toBe(references);
  });
  it('retains Review, Case Study and Company Profile claims while excluding stale video claims after a switch', async () => {
    await load();
    const retained = sources.statements.filter(statement => !statement.reference.type.startsWith('VIDEO_')).map(statement => statement.reference);
    draft.state.choices!.claims = [...retained, { type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 }];
    draft.state.choices!.video = { ...review.video, locator: { ...review.video.locator, sourceVideoMediaId: 'previous-video' } };
    const checks = nodes(render()).filter(node => node.type === 'input');
    expect(checks.map(check => check.props.checked)).toEqual([false, false, false, true, true, true]);
    expect(renderToStaticMarkup(render())).toContain('3 selected');
  });
});
