import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import {
  creativeImageHttpError,
  creativeImageMissingOutputError,
  CreativeImageProviderError,
  fetchCreativeImage,
  runCreativeImageModelRoute,
} from '@/lib/creatives/image-models';

const baseRequest = {
  context: 'Create compliant TRA concepts.',
  variationCount: 4,
};

afterEach(() => vi.unstubAllGlobals());

describe('automatic creative image model routing', () => {
  it('does not accept a client-selected image model', () => {
    expect(validateGenerateCreativeRequest({
      ...baseRequest,
      imageModel: 'gpt-image-2.5-flare',
    })).toEqual({ success: false, error: 'imageModel is selected automatically' });
  });

  it('uses Sunburst without fallback for every operation type', async () => {
    for (const operationType of [
      'PROMPT_GENERATION', 'LAYOUT_REFERENCE_GENERATION',
      'TRA_REFERENCE_GENERATION', 'TRA_VIDEO_FRAME_GENERATION',
      'EDIT', 'REGENERATE', 'VARIATION', 'PLACEMENT',
    ] as const) {
      const generate = vi.fn().mockResolvedValue('image');
      const result = await runCreativeImageModelRoute({ operationType, generate });
      expect(generate).toHaveBeenCalledWith('gpt-image-2.5-sunburst');
      expect(generate).toHaveBeenCalledTimes(1);
      expect(result.routing).toEqual({
        operationType,
        preferredModel: 'gpt-image-2.5-sunburst',
        actualModel: 'gpt-image-2.5-sunburst',
        fallbackUsed: false,
        fallbackFromModel: null,
        fallbackReason: null,
      });
    }
  });

  it.each([
    [new CreativeImageProviderError('Rate limit', 'rate_limited'), 'rate_limited'],
    [new CreativeImageProviderError('Overloaded', 'provider_unavailable'), 'provider_unavailable'],
  ])('retries one transient failure once with hidden Flare', async (failure, reason) => {
    const generate = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('fallback-image');
    const result = await runCreativeImageModelRoute({
      operationType: 'EDIT',
      generate,
    });
    expect(generate.mock.calls.map(([model]) => model)).toEqual([
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
    ]);
    expect(result).toEqual({
      value: 'fallback-image',
      routing: {
        operationType: 'EDIT',
        preferredModel: 'gpt-image-2.5-sunburst',
        actualModel: 'gpt-image-2.5-flare',
        fallbackUsed: true,
        fallbackFromModel: 'gpt-image-2.5-sunburst',
        fallbackReason: reason,
      },
    });
  });

  it.each([400, 401, 403])('does not fallback for deterministic HTTP %i', async status => {
    const failure = creativeImageHttpError(status, 'deterministic failure');
    const generate = vi.fn().mockRejectedValue(failure);
    await expect(runCreativeImageModelRoute({
      operationType: 'PROMPT_GENERATION',
      generate,
    })).rejects.toBe(failure);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not classify unrelated implementation errors as network failures', async () => {
    const failure = new TypeError('invalid local input');
    const generate = vi.fn().mockRejectedValue(failure);
    await expect(runCreativeImageModelRoute({
      operationType: 'PROMPT_GENERATION',
      generate,
    })).rejects.toBe(failure);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('sanitizes fetch network failures for the routing fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket details')));
    await expect(fetchCreativeImage('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-image-2.5-sunburst', prompt: 'Fixture', size: '1024x1024' }),
    })).rejects.toMatchObject({ fallbackReason: null, outcome: 'UNKNOWN' });
  });

  it('makes at most two attempts when the fallback also fails', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new CreativeImageProviderError('preferred failed', 'provider_unavailable'))
      .mockRejectedValueOnce(new Error('fallback failed'));
    await expect(runCreativeImageModelRoute({
      operationType: 'TRA_REFERENCE_GENERATION',
      generate,
    })).rejects.toThrow('fallback failed');
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
