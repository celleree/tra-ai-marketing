import { describe, expect, it } from 'vitest';
import { CREATIVE_PLACEMENTS, CREATIVE_PLACEMENT_SPECS, isCreativePlacement } from '@/lib/creatives/placements';

describe('creative placement dimensions', () => {
  it.each(CREATIVE_PLACEMENTS)('renders %s at its exact ratio within provider limits', (placement) => {
    const spec = CREATIVE_PLACEMENT_SPECS[placement];
    const [ratioWidth, ratioHeight] = spec.aspectRatio.split(':').map(Number);
    expect(spec.width * ratioHeight).toBe(spec.height * ratioWidth);
    expect(spec.providerSize).toBe(`${spec.width}x${spec.height}`);
    expect(spec.width % 16).toBe(0);
    expect(spec.height % 16).toBe(0);
    expect(Math.max(spec.width, spec.height)).toBeLessThanOrEqual(3840);
    expect(Math.max(spec.width, spec.height) / Math.min(spec.width, spec.height)).toBeLessThanOrEqual(3);
    expect(spec.width * spec.height).toBeGreaterThanOrEqual(655360);
    expect(spec.width * spec.height).toBeLessThanOrEqual(8294400);
  });

  it('keeps the existing square size and uses exact vertical ratios instead of the 2:3 preset', () => {
    expect(CREATIVE_PLACEMENT_SPECS.SQUARE_1_1.providerSize).toBe('1024x1024');
    expect(CREATIVE_PLACEMENT_SPECS.PORTRAIT_4_5.aspectRatio).toBe('4:5');
    expect(CREATIVE_PLACEMENT_SPECS.VERTICAL_9_16.aspectRatio).toBe('9:16');
    expect(CREATIVE_PLACEMENT_SPECS.VERTICAL_9_16.providerSize).not.toBe('1024x1536');
  });

  it('accepts placement IDs without confusing ad styles or arbitrary sizes with placements', () => {
    for (const placement of CREATIVE_PLACEMENTS) expect(isCreativePlacement(placement)).toBe(true);
    for (const value of ['proof', 'educational', '1024x1536', '9:16', '', null, {}, 1]) {
      expect(isCreativePlacement(value)).toBe(false);
    }
  });
});
