import { describe, expect, it } from 'vitest';
import { normalizeProviderUsage, providerUsageEvent } from '@/lib/ai/provider-usage';
import { estimateProviderCostUsd } from '@/lib/ai/provider-pricing';

describe('provider usage minimization and pricing', () => {
  it('keeps only numeric usage categories and never converts missing data to zero', () => {
    expect(normalizeProviderUsage({ type: 'duration', seconds: 9 })).toEqual({ audioSeconds: 9 });
    expect(normalizeProviderUsage({ duration: 8.47 })).toBeNull();
    expect(normalizeProviderUsage(undefined)).toBeNull(); expect(normalizeProviderUsage({})).toBeNull();
    expect(normalizeProviderUsage({ input_tokens: 5, output_tokens: -1, total_tokens: 'PRIVATE', prompt: 'PRIVATE',
      input_tokens_details: { cached_tokens: 0, text_tokens: 5, image_tokens: 0, secret: 'PRIVATE' } }))
      .toEqual({ inputTokens: 5, cachedInputTokens: 0, inputTextTokens: 5, inputImageTokens: 0 });
    expect(estimateProviderCostUsd('gpt-image-2.5-sunburst', 'images', null)).toBeNull();
    expect(estimateProviderCostUsd('gpt-image-2.5-sunburst', 'images', { inputTokens: 5, outputTokens: 5 })).toBeNull();
  });
  it('estimates direct Images without applying the Responses cached-input discount', () => {
    const usage = { inputTokens: 300, inputTextTokens: 100, inputImageTokens: 200, outputTokens: 1000, cachedInputTokens: 200 };
    expect(estimateProviderCostUsd('gpt-image-2.5-sunburst', 'images', usage)).toBeCloseTo(.0321);
    expect(estimateProviderCostUsd('gpt-image-2.5-flare', 'images', usage)).toBeCloseTo(.0321);
    expect(estimateProviderCostUsd('gpt-image-2.5-sunburst', 'images', { ...usage, inputTokens: 301 })).toBeNull();
    expect(estimateProviderCostUsd('unknown-model', 'images', usage)).toBeNull();
    expect(estimateProviderCostUsd('gpt-image-2.5-sunburst', 'images', usage, 'fast')).toBeNull();
  });
  it('uses whole-request long-context rates only above 272K and separates cache categories', () => {
    const usage = { inputTokens: 272000, outputTokens: 100, cachedInputTokens: 1000, cacheWriteTokens: 2000 };
    expect(estimateProviderCostUsd('gpt-6-astra', 'responses', usage)).toBeCloseTo((269000 * 10 + 1000 + 2000 * 12.5 + 100 * 50) / 1e6);
    expect(estimateProviderCostUsd('gpt-6-astra', 'responses', { ...usage, inputTokens: 272001 }))
      .toBeCloseTo((269001 * 20 + 1000 * 2 + 2000 * 25 + 100 * 75) / 1e6);
    expect(estimateProviderCostUsd('gpt-5.6-terra', 'responses', usage)).toBeCloseTo((269000 * 2 + 1000 * .2 + 2000 * 2.5 + 100 * 12) / 1e6);
    expect(estimateProviderCostUsd('gpt-6-astra', 'responses', { inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(estimateProviderCostUsd('whisper-1', 'transcription', { audioSeconds: 30 })).toBeCloseTo(.003);
  });
  it('does not retain arbitrary metadata, secrets, prompts, PII or response text', () => {
    const event = providerUsageEvent({ attemptId: 'attempt-1', stage: 'image', endpoint: 'images', purpose: 'production',
      model: 'gpt-image-2.5-sunburst', quality: 'high', dimensions: '1024x1024', n: 1, renderFingerprint: 'a'.repeat(64),
      prompt: 'PRIVATE PROMPT', headers: { Authorization: 'PRIVATE KEY' }, runId: 'https://private-url?token=PRIVATE',
    } as any, { status: 'succeeded', usage: { input_tokens: 5, output_text: 'PRIVATE PII' }, requestId: 'req_123',
    }, 'b'.repeat(40));
    expect(JSON.stringify(event)).not.toContain('PRIVATE'); expect(event.runId).toBeNull();
    expect(event.confirmedBilledCostUsd).toBeNull(); expect(event.estimatedCostUsd).toBeNull();
    expect(event).toMatchObject({ attemptId: 'attempt-1', requestId: 'req_123', providerDispatched: true, quality: 'high', n: 1 });
    const reused = providerUsageEvent({ attemptId: 'attempt-1', stage: 'image', endpoint: 'images', purpose: 'production' },
      { status: 'reused' });
    expect(reused).toMatchObject({ providerDispatched: false, cacheReuse: true, usage: null, estimatedCostUsd: null });
  });
});
