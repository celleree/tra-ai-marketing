import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { withNormalPreviewPortfolio } from '@/lib/creatives/preview-portfolio-scope';
import { assertPreviewAcceptanceJob, isPreviewAcceptanceOperation } from '@/lib/creatives/preview-acceptance';
import { PREVIEW_TEST_APPROVAL, withApprovedPreviewPortfolio } from '@/lib/creatives/preview-test-approval';
import { fetchWithProviderUsage, withProviderUsageContext } from '@/lib/ai/provider-telemetry';
import { fetchCreativeImage, runCreativeImageModelRoute } from '@/lib/creatives/image-models';
import { imageAttemptBudget, withImageAttemptScope } from '@/lib/creatives/image-attempt-execution';
import { MemoryPortfolioStorage, portfolioRequest } from '../fixtures/creative-portfolio';
import { choices } from '../fixtures/video-review-selection';
// Exercise the real server admission guard even with a mocked dispatch.
vi.unmock('@/lib/creatives/image-provider-admission');

const ordinary = () => newCreativePortfolio({ ...portfolioRequest(4), context: 'User changed this prompt and layout context.' });
const init = { method: 'POST', body: JSON.stringify({ model: 'existing-model', store: false, input: 'New user layout direction' }) };
const fetchStage = (id: string, dispatch: typeof fetch, stage = 'source-reference-analysis') =>
  withProviderUsageContext({ portfolioId: id }, () => fetchWithProviderUsage(stage, 'existing-model',
    'https://api.openai.com/v1/responses', init, dispatch));
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('admits changed-prompt normal Create preparation/planning only inside its server-owned portfolio scope', async () => {
  const job = ordinary(), storage = new MemoryPortfolioStorage();
  const dispatch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ status: 'completed' }));
  expect(() => assertPreviewAcceptanceJob(job)).not.toThrow();
  await withNormalPreviewPortfolio(job, 'authenticated-operator', () => withApprovedPreviewPortfolio(job, storage, async () => {
    expect(isPreviewAcceptanceOperation()).toBe(false);
    for (const stage of ['source-reference-analysis', 'layout-analysis', 'creative-plan', 'portfolio-audit', 'creative-plan-repair']) {
      await fetchStage(job.id, dispatch, stage);
    }
  }));
  expect(dispatch).toHaveBeenCalledTimes(5);
  expect(dispatch.mock.calls.every(([, options]) => options?.body === init.body)).toBe(true);
  expect(storage.data.size).toBe(0); // No QA approval receipt or normalization was inherited.
  await expect(fetchStage(job.id, dispatch)).rejects.toThrow('before dispatch');
  expect(dispatch).toHaveBeenCalledTimes(5);
});

it.each(['current-id', 'previous-id', 'reserved-creative'] as const)
('never treats a forged or invalid QA identity (%s) as ordinary Create', async variant => {
  const job = ordinary(), storage = new MemoryPortfolioStorage(), dispatch = vi.fn<typeof fetch>();
  if (variant === 'current-id') job.id = PREVIEW_TEST_APPROVAL.portfolioId;
  if (variant === 'previous-id') job.id = PREVIEW_TEST_APPROVAL.previousPortfolioId;
  if (variant === 'reserved-creative') job.slots[0].creativeId = PREVIEW_TEST_APPROVAL.creativeIds[0];
  expect(() => assertPreviewAcceptanceJob(job)).toThrow();
  await expect(withNormalPreviewPortfolio(job, 'operator', () => withApprovedPreviewPortfolio(job, storage,
    () => fetchStage(job.id, dispatch)))).rejects.toThrow('before dispatch');
  expect(dispatch).not.toHaveBeenCalled(); expect(storage.data.size).toBe(0);
});

it('rejects lost/mismatched provider context and QA creative identities even inside an ordinary scope', async () => {
  const job = ordinary(), dispatch = vi.fn<typeof fetch>();
  await withNormalPreviewPortfolio(job, 'operator', async () => {
    for (const id of [PREVIEW_TEST_APPROVAL.portfolioId, PREVIEW_TEST_APPROVAL.previousPortfolioId, 'another-portfolio', undefined]) {
      await expect(withProviderUsageContext({ portfolioId: id }, () => fetchWithProviderUsage('source-reference-analysis',
        'existing-model', 'https://api.openai.com/v1/responses', init, dispatch))).rejects.toThrow('before dispatch');
    }
    await expect(withProviderUsageContext({ portfolioId: job.id, creativeId: PREVIEW_TEST_APPROVAL.creativeIds[0] }, () =>
      fetchWithProviderUsage('source-reference-analysis', 'existing-model', 'https://api.openai.com/v1/responses', init, dispatch)))
      .rejects.toThrow('before dispatch');
  });
  expect(dispatch).not.toHaveBeenCalled();
});

it('fails closed on changed QA inputs even when its count, placement and source shape remain valid', async () => {
  const qa = newCreativePortfolio({ context: 'Changed frozen QA prompt', variationCount: 2, placement: 'PORTRAIT_4_5',
    brandLogoMediaId: 'media_' + 'e'.repeat(32), sourceAssets: [
      { role: 'TRA_VIDEO', mediaId: choices().video!.locator.sourceVideoMediaId },
      { role: 'LAYOUT_REFERENCE', mediaId: 'media_' + 'f'.repeat(32) },
    ], reviewHandoff: { choices: choices() } as any });
  qa.id = PREVIEW_TEST_APPROVAL.portfolioId;
  qa.slots.forEach((slot, index) => { slot.creativeId = PREVIEW_TEST_APPROVAL.creativeIds[index]; });
  expect(() => assertPreviewAcceptanceJob(qa)).toThrow('frozen inputs changed');
  const dispatch = vi.fn<typeof fetch>(), storage = new MemoryPortfolioStorage();
  await expect(withNormalPreviewPortfolio(qa, 'operator', () => withApprovedPreviewPortfolio(qa, storage,
    () => fetchStage(qa.id, dispatch)))).rejects.toThrow('before dispatch');
  expect(dispatch).not.toHaveBeenCalled(); expect(storage.data.size).toBe(0);
});

it('keeps concurrent normal/QA execution contexts separate and refuses admission without operator identity', async () => {
  const normal = ordinary(), qa = ordinary(); qa.id = PREVIEW_TEST_APPROVAL.portfolioId;
  const dispatch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'completed' }));
  const results = await Promise.allSettled([
    withNormalPreviewPortfolio(normal, 'operator', async () => { await Promise.resolve(); return fetchStage(normal.id, dispatch); }),
    withNormalPreviewPortfolio(qa, 'operator', async () => { await Promise.resolve(); return fetchStage(qa.id, dispatch); }),
  ]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  await expect(withNormalPreviewPortfolio(normal, '', () => fetchStage(normal.id, dispatch))).rejects.toThrow('before dispatch');
  expect(dispatch).toHaveBeenCalledOnce();
});

it('does not clear or grant normal admission to any terminal job', async () => {
  const job = ordinary(); job.previewAcceptanceError = 'A preserved terminal stop';
  const dispatch = vi.fn<typeof fetch>();
  await expect(withNormalPreviewPortfolio(job, 'operator', () => fetchStage(job.id, dispatch))).rejects.toThrow('before dispatch');
  expect(job.previewAcceptanceError).toBe('A preserved terminal stop'); expect(dispatch).not.toHaveBeenCalled();
});

const imageRequest = { method: 'POST', body: JSON.stringify({ model: 'gpt-image-2.5-sunburst', size: '1024x1024', prompt: 'Normal user Create' }) };
it('preserves server-only live-image authorization for normal Preview Create', async () => {
  vi.stubEnv('TRA_LIVE_IMAGE_AUTHORIZATION', '');
  const job = ordinary(), dispatch = vi.spyOn(globalThis, 'fetch');
  await expect(withNormalPreviewPortfolio(job, 'operator', () => withProviderUsageContext({ portfolioId: job.id }, () =>
    fetchCreativeImage('https://api.openai.com/v1/images/generations', imageRequest)))).rejects.toThrow('Live image generation is disabled');
  expect(dispatch).not.toHaveBeenCalled();
});

it('preserves purchased-result ledgers, unknown-outcome stops and zero staging fallback for normal Create', async () => {
  vi.stubEnv('TRA_LIVE_IMAGE_AUTHORIZATION', 'allow-paid-image-generation');
  const job = ordinary(), storage = new MemoryPortfolioStorage();
  const dispatch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider outcome unknown'));
  const render = () => withNormalPreviewPortfolio(job, 'operator', () => withProviderUsageContext({ portfolioId: job.id }, () =>
    withImageAttemptScope({ runId: `portfolio:${job.id}`, operationId: job.slots[0].creativeId, creativeId: job.slots[0].creativeId,
      portfolioId: job.id, storage, budget: imageAttemptBudget(4) }, () => runCreativeImageModelRoute({
        operationType: 'PROMPT_GENERATION', generate: () => fetchCreativeImage('https://api.openai.com/v1/images/generations', imageRequest),
      }))));
  expect(imageAttemptBudget(4)).toMatchObject({ purpose: 'staging-smoke', primaryLimit: 4, fallbackLimit: 0 });
  await expect(render()).rejects.toThrow('unknown'); await expect(render()).rejects.toThrow('no repeat purchase');
  expect(dispatch).toHaveBeenCalledOnce();
});
