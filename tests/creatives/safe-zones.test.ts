import { describe, expect, it } from 'vitest';
import { CREATIVE_PLACEMENTS, CREATIVE_PLACEMENT_SPECS } from '@/lib/creatives/placements';
import { formatCreativeLogoReservation, formatCreativeSafeZoneRules, getCreativeLogoReservedRect, getCreativeSafeRect } from '@/lib/creatives/safe-zones';

describe('Stories composition boundaries', () => {
  it('rounds the Stories safe rectangle inward at the exact provider dimensions', () => {
    expect(getCreativeSafeRect('VERTICAL_9_16')).toEqual({ left: 70, top: 287, width: 1012, height: 1044 });
    const prompt = formatCreativeSafeZoneRules('VERTICAL_9_16');
    expect(prompt).toContain('Facebook and Instagram Stories, not Reels');
    expect(prompt).toContain('x=70..1081, y=287..1330');
    expect(prompt).toContain('not visible borders');
    expect(prompt).toContain('Human review must confirm');
  });
  it.each(['SQUARE_1_1', 'PORTRAIT_4_5'] as const)('does not impose Stories exclusions on %s', placement => {
    const spec = CREATIVE_PLACEMENT_SPECS[placement];
    expect(getCreativeSafeRect(placement)).toEqual({ left: 0, top: 0, width: spec.width, height: spec.height });
    expect(formatCreativeSafeZoneRules(placement)).toBe('');
  });
  it.each(CREATIVE_PLACEMENTS)('keeps the maximum logo panel inside the %s content area', placement => {
    const safe = getCreativeSafeRect(placement), logo = getCreativeLogoReservedRect(placement);
    expect(logo.left).toBeGreaterThanOrEqual(safe.left);
    expect(logo.top).toBeGreaterThanOrEqual(safe.top);
    expect(logo.left + logo.width).toBeLessThanOrEqual(safe.left + safe.width);
    expect(logo.top + logo.height).toBeLessThanOrEqual(safe.top + safe.height);
    expect(formatCreativeLogoReservation(placement)).toContain(`x=${logo.left}..${logo.left + logo.width - 1}`);
  });
});
