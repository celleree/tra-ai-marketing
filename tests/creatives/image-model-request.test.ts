import { describe, expect, it } from 'vitest';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';

const baseRequest = {
  context: 'Create compliant TRA concepts.',
  variationCount: 4,
};

describe('creative image model request', () => {
  it('defaults to GPT Image 2.5 Flare', () => {
    const result = validateGenerateCreativeRequest(baseRequest);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.imageModel).toBe('gpt-image-2.5-flare');
  });

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const)(
    'accepts supported model %s',
    (imageModel) => {
      const result = validateGenerateCreativeRequest({ ...baseRequest, imageModel });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.imageModel).toBe(imageModel);
    }
  );

  it.each(['gpt-image-2', 'arbitrary-model', '', null])(
    'rejects unsupported client model %j',
    (imageModel) => {
      expect(
        validateGenerateCreativeRequest({ ...baseRequest, imageModel })
      ).toEqual({ success: false, error: 'imageModel is unsupported' });
    }
  );
});
