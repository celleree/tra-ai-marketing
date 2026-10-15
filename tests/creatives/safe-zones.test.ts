import { describe, expect, it } from 'vitest';
import { CREATIVE_PLACEMENTS, CREATIVE_PLACEMENT_SPECS } from '@/lib/creatives/placements';
import { formatCreativeLogoReservation, formatCreativeSafeZoneRules, getCreativeSafeRect } from '@/lib/creatives/safe-zones';
import { CREATIVE_LOGO_ANCHORS, resolveCreativeLogoGeometry, resolveLayoutAwareLogoAnchor } from '@/lib/creatives/logo-placement';
import { referenceCandidate } from '../fixtures/reference-catalog';

describe('Stories composition boundaries', () => {
  it('rounds the Stories safe rectangle inward at the exact provider dimensions', () => {
    expect(getCreativeSafeRect('VERTICAL_9_16')).toEqual({ left: 70, top: 287, width: 1012, height: 1044 });
    const prompt = formatCreativeSafeZoneRules('VERTICAL_9_16');
    expect(prompt).toContain('Facebook and Instagram Stories, not Reels');
    expect(prompt).toContain('x=70..1081, y=287..1330');
    expect(prompt).toContain('not visible borders');
    expect(prompt).toContain('Human review must confirm');
  });

  it('uses an explicit layout logo region and otherwise avoids known text, CTA, and human regions', () => {
    const base = referenceCandidate().blueprint.regions[0];
    const withPlaceholder = { ...referenceCandidate().blueprint, regions: [
      { ...base, role: 'LOGO_PLACEHOLDER' as const, xPct: 75, yPct: 80, widthPct: 20, heightPct: 10 },
    ] };
    expect(resolveLayoutAwareLogoAnchor('top-left', withPlaceholder)).toBe('bottom-right');

    const occupiedTopAndBottomLeft = { ...referenceCandidate().blueprint, regions: [
      { ...base, role: 'HEADLINE' as const, xPct: 0, yPct: 0, widthPct: 35, heightPct: 20 },
      { ...base, role: 'HUMAN_PLACEHOLDER' as const, xPct: 34, yPct: 0, widthPct: 32, heightPct: 30 },
      { ...base, role: 'CTA' as const, xPct: 66, yPct: 0, widthPct: 34, heightPct: 20 },
      { ...base, role: 'SUPPORTING_TEXT' as const, xPct: 0, yPct: 80, widthPct: 40, heightPct: 20 },
    ] };
    expect(resolveLayoutAwareLogoAnchor('top-left', occupiedTopAndBottomLeft)).toBe('bottom-right');

    const storiesCta = { ...referenceCandidate().blueprint, regions: [
      { ...base, role: 'CTA' as const, xPct: 0, yPct: 50, widthPct: 40, heightPct: 15 },
    ] };
    expect(resolveLayoutAwareLogoAnchor('bottom-left', storiesCta, {
      placement: 'VERTICAL_9_16', sourceWidth: 200, sourceHeight: 100,
    })).toBe('top-left');
  });
  it.each(['SQUARE_1_1', 'PORTRAIT_4_5'] as const)('does not impose Stories exclusions on %s', placement => {
    const spec = CREATIVE_PLACEMENT_SPECS[placement];
    expect(getCreativeSafeRect(placement)).toEqual({ left: 0, top: 0, width: spec.width, height: spec.height });
    expect(formatCreativeSafeZoneRules(placement)).toBe('');
  });
  it.each(CREATIVE_PLACEMENTS.flatMap(placement => CREATIVE_LOGO_ANCHORS.map(anchor => [placement, anchor] as const)))('keeps the %s %s logo panel inside the content area', (placement, anchor) => {
    const safe = getCreativeSafeRect(placement), logo = resolveCreativeLogoGeometry(placement, anchor, 200, 100).panel;
    expect(logo.left).toBeGreaterThanOrEqual(safe.left);
    expect(logo.top).toBeGreaterThanOrEqual(safe.top);
    expect(logo.left + logo.width).toBeLessThanOrEqual(safe.left + safe.width);
    expect(logo.top + logo.height).toBeLessThanOrEqual(safe.top + safe.height);
    expect(formatCreativeLogoReservation(resolveCreativeLogoGeometry(placement, anchor, 200, 100))).toContain(`x=${logo.left}..${logo.left + logo.width - 1}`);
  });
});
