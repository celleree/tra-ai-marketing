import type { ProviderEndpoint, ProviderUsage } from '@/lib/ai/provider-usage';

/** Standard direct API baseline, verified 2026-09-26; estimates exclude regional/FedRAMP uplift.
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * https://developers.openai.com/api/docs/models/whisper-1
 */
export const PROVIDER_PRICING = {
  version: 'openai-standard-2026-09-26-v1', currency: 'USD', perTokens: 1_000_000, longContextAbove: 272_000,
  images: {
    'gpt-image-2.5-sunburst': { textInput: 5, imageInput: 8, output: 30 },
    'gpt-image-2.5-flare': { textInput: 5, imageInput: 8, output: 30 },
  },
  responses: {
    'gpt-6-astra': { short: { input: 10, cached: 1, write: 12.5, output: 50 }, long: { input: 20, cached: 2, write: 25, output: 75 } },
    'gpt-5.6-terra': { short: { input: 2, cached: .2, write: 2.5, output: 12 }, long: { input: 4, cached: .4, write: 5, output: 18 } },
  },
  transcriptionPerMinute: { 'whisper-1': .006 },
} as const;

/** Missing categories and unsupported model/tier combinations remain unknown, never zero. */
export function estimateProviderCostUsd(model: string | undefined, endpoint: ProviderEndpoint, usage: ProviderUsage | null,
  serviceTier = 'default'): number | null {
  if (!model || !usage || !['default', 'standard', 'auto'].includes(serviceTier)) return null;
  if (Object.values(usage).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
  if (endpoint === 'transcription') {
    return model === 'whisper-1' && usage.audioSeconds !== undefined
      ? usage.audioSeconds / 60 * PROVIDER_PRICING.transcriptionPerMinute[model] : null;
  }
  const { inputTokens: input, outputTokens: output } = usage;
  if (input === undefined || output === undefined || !Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return null;
  if (usage.totalTokens !== undefined && usage.totalTokens !== input + output) return null;
  if (endpoint === 'images') {
    const rates = PROVIDER_PRICING.images[model as keyof typeof PROVIDER_PRICING.images];
    const { inputTextTokens: text, inputImageTokens: image } = usage;
    if (!rates || text === undefined || image === undefined || text + image !== input) return null;
    // Direct Images does not receive the Responses image-tool cached-input discount.
    return (text * rates.textInput + image * rates.imageInput + output * rates.output) / PROVIDER_PRICING.perTokens;
  }
  const price = PROVIDER_PRICING.responses[model as keyof typeof PROVIDER_PRICING.responses];
  const { cachedInputTokens: cached, cacheWriteTokens: write } = usage;
  if (!price || cached === undefined || write === undefined || cached + write > input) return null;
  const rates = price[input > PROVIDER_PRICING.longContextAbove ? 'long' : 'short'];
  return ((input - cached - write) * rates.input + cached * rates.cached + write * rates.write + output * rates.output)
    / PROVIDER_PRICING.perTokens;
}
