import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
const mocks = vi.hoisted(() => ({ settled: true, sources: [] as unknown[], arrayState: 0, logoId: '', stateUpdates: [] as unknown[], saved: null as null | { draft: { id: string }; revision: string; issues: [] }, start: vi.fn(), resume: vi.fn(), retry: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: () => {},
  useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [Array.isArray(value) && mocks.arrayState++ === 0 ? mocks.sources : value === '' ? 'A creative prompt' : value, (value: unknown) => mocks.stateUpdates.push(value)] }));
vi.mock('@/components/creative-generator/use-video-review-draft', () => ({ useVideoReviewDraft: () => ({
  state: { error: '', pending: 0, saved: mocks.saved }, canGenerate: () => mocks.settled,
  profileChanged: () => false, generationReference: () => mocks.saved ? { draftId: mocks.saved.draft.id, revision: mocks.saved.revision } : undefined }) }));
vi.mock('@/components/creative-generator/use-saved-video-sources', () => ({ useSavedVideoSources: () => ({ pending: false, error: '' }) }));
vi.mock('@/components/creative-generator/use-creative-portfolio', () => ({ useCreativePortfolio: () => ({
  running: false, start: mocks.start, resume: mocks.resume, retry: mocks.retry, response: null }) }));
vi.mock('@/lib/creatives/brand-guidance', () => ({ readStoredBrandGuidance: () => ({ colors: [], fontGuidance: [], logo: mocks.logoId ? { mediaId: mocks.logoId, url: `/api/media/files/${mocks.logoId}.png` } : null }) }));
vi.mock('@/lib/company/creative-context', async original => ({ ...await original<object>(), readStoredRuntimeCompanyProfile: () => undefined }));
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';
import { CreativeComposer } from '@/components/creative-generator/creative-composer';
import { VideoReviewPanel } from '@/components/creative-generator/video-review-panel';
import { PortfolioProgressPanel } from '@/components/creative-generator/portfolio-progress-panel';
import type { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
const nodes = (tree: unknown): ReactElement<Record<string, unknown>>[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
  : 'props' in tree ? [tree as ReactElement<Record<string, unknown>>, ...nodes((tree as ReactElement<{ children?: unknown }>).props.children)] : [];
beforeEach(() => { vi.clearAllMocks(); mocks.settled = true; mocks.saved = null; mocks.sources = []; mocks.arrayState = 0; mocks.logoId = `media_${'d'.repeat(32)}`; mocks.stateUpdates = []; });
describe('Create generation review-save gate', () => {
  it('blocks a missing origin-local logo before submitting a paid generation job', async () => {
    mocks.logoId = '';
    const tree = nodes(CreativeGenerator());
    await (tree.find(node => node.type === CreativeComposer)!.props.onSubmit as () => Promise<void>)();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.stateUpdates).toContain('The approved TRA logo is missing for this site. Restore the original logo in Company > Brand Guidelines before generating.');
  });
  it('submits the video, explicit layout, saved frame review and exact logo identity together', async () => {
    const videoId = `media_${'b'.repeat(32)}`, layoutId = `media_${'c'.repeat(32)}`;
    mocks.sources = [{ role: 'TRA_VIDEO', media: { id: videoId, mediaType: 'VIDEO', fileName: 'source.mp4' } },
      { role: 'LAYOUT_REFERENCE', media: { id: layoutId, mediaType: 'IMAGE', fileName: 'layout.png' } }];
    mocks.logoId = `media_${'d'.repeat(32)}`;
    mocks.saved = { draft: { id: `review_${'a'.repeat(32)}` }, revision: 'exact-saved-revision', issues: [] };
    const tree = nodes(CreativeGenerator());
    await (tree.find(node => node.type === CreativeComposer)!.props.onSubmit as () => Promise<void>)();
    expect(mocks.start.mock.calls[0][0]).toMatchObject({ sourceAssets: [{ role: 'TRA_VIDEO', mediaId: videoId },
      { role: 'LAYOUT_REFERENCE', mediaId: layoutId }], videoReview: { draftId: mocks.saved.draft.id, revision: mocks.saved.revision },
      brandLogoMediaId: mocks.logoId });
  });
  it('puts the card below the composer and prevents a pending/failed edit bypassing Generate before rerender', async () => {
    const tree = nodes(CreativeGenerator());
    expect(tree.findIndex(node => node.type === CreativeComposer)).toBeLessThan(tree.findIndex(node => node.type === VideoReviewPanel));
    expect(tree.findIndex(node => node.type === VideoReviewPanel)).toBeLessThan(tree.findIndex(node => node.type === PortfolioProgressPanel));
    const submit = tree.find(node => node.type === CreativeComposer)!.props.onSubmit as () => Promise<void>;
    mocks.settled = false; await submit(); expect(mocks.start).not.toHaveBeenCalled();
    mocks.settled = true; await submit(); expect(mocks.start).toHaveBeenCalledTimes(1);
  });
  it('submits only the saved review reference and lets saved portfolios Resume/Retry independently of mutable review edits', async () => {
    const tree = nodes(CreativeGenerator());
    mocks.saved = { draft: { id: `review_${'a'.repeat(32)}` }, revision: 'saved-revision', issues: [] }; // Completed before rerender.
    await (tree.find(node => node.type === CreativeComposer)!.props.onSubmit as () => Promise<void>)();
    expect(mocks.start.mock.calls[0][0].videoReview).toEqual({ draftId: mocks.saved.draft.id, revision: mocks.saved.revision });
    expect(tree.find(node => node.type === PortfolioProgressPanel)!.props).not.toHaveProperty('canAdvance');
  });
  it('guards Resume and Retry handlers as well as their disabled state', () => {
    const restoreSaved = vi.fn();
    const portfolio = { running: false, resume: mocks.resume, retry: mocks.retry, restoreSaved, response: { job: {
      id: 'portfolio', requestedCount: 1, planReady: true, slots: [{ status: 'PENDING' }, { status: 'RETRY_REQUIRED', index: 2 }] } } } as unknown as ReturnType<typeof useCreativePortfolio>;
    const buttons = nodes(PortfolioProgressPanel({ portfolio, canAdvance: () => mocks.settled })).filter(node => node.type === 'button');
    const paidButtons = (tree: unknown) => nodes(tree).filter(node => node.type === 'button' && node.props.children !== 'Reload saved progress');
    mocks.settled = false; buttons.forEach(button => (button.props.onClick as () => void)());
    expect(mocks.resume).not.toHaveBeenCalled(); expect(mocks.retry).not.toHaveBeenCalled();
    expect(restoreSaved).toHaveBeenCalledOnce(); // Read-only status remains available when mutable review edits block paid work.
    expect(paidButtons(PortfolioProgressPanel({ portfolio, canAdvance: () => false })).every(node => node.props.disabled)).toBe(true);
    mocks.settled = true; buttons.forEach(button => (button.props.onClick as () => void)());
    expect(mocks.resume).toHaveBeenCalledTimes(1); expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(restoreSaved).toHaveBeenCalledTimes(2);
  });
});
