import { estimateProviderCostUsd, PROVIDER_PRICING } from '@/lib/ai/provider-pricing';

export type ProviderEndpoint = 'images' | 'responses' | 'transcription';
export type ProviderUsage = Partial<Record<'inputTokens' | 'outputTokens' | 'totalTokens' | 'cachedInputTokens'
  | 'cacheWriteTokens' | 'inputTextTokens' | 'inputImageTokens' | 'outputTextTokens' | 'outputImageTokens'
  | 'reasoningTokens' | 'audioSeconds', number>>;

/** Allowlisted counts only: no prompts, output text, URLs, headers, errors or arbitrary usage fields. */
export function normalizeProviderUsage(value: unknown): ProviderUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, any>;
  const values: Record<keyof Required<ProviderUsage>, unknown> = {
    inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, totalTokens: raw.total_tokens,
    cachedInputTokens: raw.input_tokens_details?.cached_tokens,
    cacheWriteTokens: raw.input_tokens_details?.cache_write_tokens,
    inputTextTokens: raw.input_tokens_details?.text_tokens, inputImageTokens: raw.input_tokens_details?.image_tokens,
    outputTextTokens: raw.output_tokens_details?.text_tokens, outputImageTokens: raw.output_tokens_details?.image_tokens,
    reasoningTokens: raw.output_tokens_details?.reasoning_tokens, audioSeconds: raw.type === 'duration' ? raw.seconds : undefined,
  };
  const result: ProviderUsage = {};
  for (const [name, count] of Object.entries(values)) {
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0
      && (name === 'audioSeconds' || Number.isSafeInteger(count))) result[name as keyof ProviderUsage] = count;
  }
  return Object.keys(result).length ? result : null;
}

export type ProviderUsageContext = { runId?: string; operationId?: string; jobId?: string; portfolioId?: string; creativeId?: string };
export type ProviderAttemptMetadata = ProviderUsageContext & { attemptId: string; stage: string; endpoint: ProviderEndpoint;
  model?: string; purpose: 'diagnostic' | 'staging-smoke' | 'production'; quality?: string; dimensions?: string;
  n?: number; renderFingerprint?: string; retryIndex?: number; operationType?: string };
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : null;

export function providerUsageEvent(meta: ProviderAttemptMetadata, outcome: {
  status: 'started' | 'succeeded' | 'failed' | 'unknown' | 'reused'; requestId?: string | null;
  usage?: unknown; serviceTier?: string;
}, buildSha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA) {
  const usage = outcome.status === 'reused' ? null : normalizeProviderUsage(outcome.usage);
  return {
    event: 'tra_provider_usage', version: 1, attemptId: identifier(meta.attemptId), stage: identifier(meta.stage),
    provider: 'openai', endpoint: meta.endpoint, model: identifier(meta.model), purpose: meta.purpose,
    runId: identifier(meta.runId), operationId: identifier(meta.operationId), jobId: identifier(meta.jobId),
    portfolioId: identifier(meta.portfolioId), creativeId: identifier(meta.creativeId), operationType: identifier(meta.operationType),
    quality: meta.quality === 'low' || meta.quality === 'high' ? meta.quality : null,
    dimensions: typeof meta.dimensions === 'string' && /^\d{3,5}x\d{3,5}$/.test(meta.dimensions) ? meta.dimensions : null,
    n: Number.isSafeInteger(meta.n) && meta.n! > 0 ? meta.n : null,
    retryIndex: Number.isSafeInteger(meta.retryIndex) && meta.retryIndex! >= 0 ? meta.retryIndex : null,
    renderFingerprint: typeof meta.renderFingerprint === 'string' && /^[a-f0-9]{64}$/.test(meta.renderFingerprint) ? meta.renderFingerprint : null,
    status: outcome.status, providerDispatched: outcome.status !== 'reused', cacheReuse: outcome.status === 'reused',
    requestId: identifier(outcome.requestId), usage,
    serviceTier: identifier(outcome.serviceTier),
    estimatedCostUsd: estimateProviderCostUsd(meta.model, meta.endpoint, usage, outcome.serviceTier),
    pricingVersion: PROVIDER_PRICING.version, confirmedBilledCostUsd: null,
    buildSha: typeof buildSha === 'string' && /^[a-f0-9]{7,64}$/i.test(buildSha) ? buildSha : null,
  };
}
