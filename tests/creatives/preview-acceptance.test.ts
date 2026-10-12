import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPreviewAcceptanceJob, assertPreviewAcceptanceRequest } from '@/lib/creatives/preview-acceptance';
import { fetchWithProviderUsage, withProviderUsageContext } from '@/lib/ai/provider-telemetry';
import { fetchCreativeImage } from '@/lib/creatives/image-models';
import { withImageAttemptScope, imageAttemptBudget } from '@/lib/creatives/image-attempt-execution';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { choices } from '../fixtures/video-review-selection';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const enable = () => { vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke'); };
const request = (): ValidGenerateCreativeRequest => ({ context: 'Use saved video and layout.', variationCount: 2,
  placement: 'PORTRAIT_4_5', brandLogoMediaId: `media_${'2'.repeat(32)}`,
  sourceAssets: [{ role: 'TRA_VIDEO', mediaId: choices().video!.locator.sourceVideoMediaId },
    { role: 'LAYOUT_REFERENCE', mediaId: `media_${'3'.repeat(32)}` }],
  videoReview: { draftId: `review_${'4'.repeat(32)}`, revision: 'saved' },
  reviewHandoff: { choices: choices() } as ValidGenerateCreativeRequest['reviewHandoff'],
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Preview acceptance spend boundary', () => {
  it('requires the bounded source scope and excludes repair and re-audit jobs', () => {
    enable(); const valid = request(); expect(() => assertPreviewAcceptanceRequest(valid, true)).not.toThrow();
    for (const changed of [{ ...valid, variationCount: 3 }, { ...valid, brandLogoMediaId: undefined },
      { ...valid, placement: 'SQUARE_1_1' as const },
      { ...valid, sourceAssets: valid.sourceAssets.slice(0, 1) }, { ...valid, reviewHandoff: undefined }]) {
      expect(() => assertPreviewAcceptanceRequest(changed, true)).toThrow('Preview acceptance requires');
    }
    const job = newCreativePortfolio(valid);
    expect(() => assertPreviewAcceptanceJob(job)).not.toThrow();
    job.planning = { phase: 'TARGETED_REPAIR' } as typeof job.planning;
    expect(() => assertPreviewAcceptanceJob(job)).toThrow('repair');
    job.planning = { phase: 'DIVERSITY_AUDIT', repairAttempted: true } as typeof job.planning;
    expect(() => assertPreviewAcceptanceJob(job)).toThrow('re-audit');
  });
  it.each(['layout-analysis', 'source-reference-analysis', 'video-human-selection', 'video-source-analysis',
    'video-transcription', 'video-observation', 'video-concept-selection', 'video-pool-selection',
    'reference-shortlist', 'reference-classification', 'creative-plan-repair', 'revision-plan'])
  ('blocks %s before the request or attempt-start event', async stage => {
    enable(); const dispatch = vi.fn<typeof fetch>(); const events = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(withProviderUsageContext({ portfolioId: 'owned' }, () =>
      fetchWithProviderUsage(stage, 'existing-model', 'https://api.openai.com/v1/responses', {}, dispatch))).rejects.toThrow('before dispatch');
    expect(dispatch).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
  });
  it('allows initial plan/audit and exactly two ledger-backed primary images, with no repeat purchase', async () => {
    enable(); vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'completed', output: [] }));
    await withProviderUsageContext({ portfolioId: 'owned' }, async () => {
      for (const stage of ['creative-plan', 'portfolio-audit']) {
        await fetchWithProviderUsage(stage, 'gpt-6.1-sol', 'https://api.openai.com/v1/responses', {}, text);
      }
    });
    expect(text).toHaveBeenCalledTimes(2);
    const storage = new MemoryPortfolioStorage();
    const image = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ b64_json: 'cGl4ZWxz' }] }));
    const render = (operationId: string, model = 'gpt-image-2.5-sunburst') => withImageAttemptScope({
      runId: 'one-portfolio', portfolioId: 'owned', operationId, storage, budget: imageAttemptBudget(2),
    }, () => fetchCreativeImage('https://api.openai.com/v1/images/generations', { method: 'POST',
      body: JSON.stringify({ model, size: '1024x1280', prompt: 'Approved static draft' }) }));
    await render('one'); await render('two'); await render('one');
    await expect(render('three')).rejects.toThrow();
    await expect(render('one', 'gpt-image-2.5-flare')).rejects.toThrow();
    expect(image).toHaveBeenCalledTimes(2);
  });
  it('leaves production, diagnostic Preview and unscoped operator tools unchanged', async () => {
    const dispatch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'completed', output: [] }));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const environment of ['production', 'development']) {
      vi.stubEnv('VERCEL_ENV', environment); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
      await withProviderUsageContext({ portfolioId: 'owned' }, () =>
        fetchWithProviderUsage('creative-plan-repair', 'model', 'https://api.openai.com/v1/responses', {}, dispatch));
    }
    enable(); vi.stubEnv('TRA_IMAGE_PURPOSE', 'diagnostic');
    await withProviderUsageContext({ portfolioId: 'owned' }, () =>
      fetchWithProviderUsage('video-human-selection', 'model', 'https://api.openai.com/v1/responses', {}, dispatch));
    enable(); await fetchWithProviderUsage('video-human-selection', 'model', 'https://api.openai.com/v1/responses', {}, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(4);
  });
  it('blocks planner model drift before dispatch', async () => {
    enable(); const dispatch = vi.fn<typeof fetch>(); vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(withProviderUsageContext({ portfolioId: 'owned' }, () =>
      fetchWithProviderUsage('creative-plan', 'different-model', 'https://api.openai.com/v1/responses', {}, dispatch))).rejects.toThrow('before dispatch');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
