import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
const mocks = vi.hoisted(() => ({ settled: true, saved: null as null | { draft: { id: string }; revision: string; issues: [] }, start: vi.fn(), resume: vi.fn(), retry: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: () => {},
  useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value === '' ? 'A creative prompt' : value, () => {}] }));
vi.mock('@/components/creative-generator/use-video-review-draft', () => ({ useVideoReviewDraft: () => ({
  state: { error: '', pending: 0, saved: mocks.saved }, canGenerate: () => mocks.settled,
  generationReference: () => mocks.saved ? { draftId: mocks.saved.draft.id, revision: mocks.saved.revision } : undefined }) }));
vi.mock('@/components/creative-generator/use-creative-portfolio', () => ({ useCreativePortfolio: () => ({
  running: false, start: mocks.start, resume: mocks.resume, retry: mocks.retry, response: null }) }));
vi.mock('@/lib/creatives/brand-guidance', () => ({ readStoredBrandGuidance: () => ({ colors: [], fontGuidance: [] }) }));
vi.mock('@/lib/company/creative-context', async original => ({ ...await original<object>(), readStoredRuntimeCompanyProfile: () => undefined }));
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';
import { CreativeComposer } from '@/components/creative-generator/creative-composer';
import { VideoReviewPanel } from '@/components/creative-generator/video-review-panel';
import { PortfolioProgressPanel } from '@/components/creative-generator/portfolio-progress-panel';
import type { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
const nodes = (tree: unknown): ReactElement<Record<string, unknown>>[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
  : 'props' in tree ? [tree as ReactElement<Record<string, unknown>>, ...nodes((tree as ReactElement<{ children?: unknown }>).props.children)] : [];
beforeEach(() => { vi.clearAllMocks(); mocks.settled = true; mocks.saved = null; });
describe('Create generation review-save gate', () => {
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
    const portfolio = { running: false, resume: mocks.resume, retry: mocks.retry, response: { job: {
      id: 'portfolio', requestedCount: 1, planReady: true, slots: [{ status: 'PENDING' }, { status: 'RETRY_REQUIRED', index: 2 }] } } } as unknown as ReturnType<typeof useCreativePortfolio>;
    const buttons = nodes(PortfolioProgressPanel({ portfolio, canAdvance: () => mocks.settled })).filter(node => node.type === 'button');
    mocks.settled = false; buttons.forEach(button => (button.props.onClick as () => void)());
    expect(mocks.resume).not.toHaveBeenCalled(); expect(mocks.retry).not.toHaveBeenCalled();
    expect(nodes(PortfolioProgressPanel({ portfolio, canAdvance: () => false })).filter(node => node.type === 'button').every(node => node.props.disabled)).toBe(true);
    mocks.settled = true; buttons.forEach(button => (button.props.onClick as () => void)());
    expect(mocks.resume).toHaveBeenCalledTimes(1); expect(mocks.retry).toHaveBeenCalledTimes(1);
  });
});
