import { CREATIVE_PLACEMENT_SPECS, type CreativePlacement } from '@/lib/creatives/placements';
import type { CreativeLogoGeometry } from '@/lib/creatives/logo-placement';

export type CreativeContentRect = { left: number; top: number; width: number; height: number };

// Stage 1 vertical images target Facebook/Instagram Stories only. Meta image guidance,
// verified 2026-09-07, reserves 14% top, 35% bottom and 6% on each side:
// https://www.facebook.com/business/ads-guide/update/image/facebook-story
// https://www.facebook.com/business/ads-guide/update/image/instagram-story
// No platform overlay exclusion is asserted for square/portrait feed images.
export function getCreativeSafeRect(placement: CreativePlacement): CreativeContentRect {
  const { width, height } = CREATIVE_PLACEMENT_SPECS[placement];
  if (placement !== 'VERTICAL_9_16') return { left: 0, top: 0, width, height };
  const left = Math.ceil(width * 0.06);
  const top = Math.ceil(height * 0.14);
  return { left, top, width: Math.floor(width * 0.94) - left, height: Math.floor(height * 0.65) - top };
}

export function formatCreativeSafeZoneRules(placement: CreativePlacement): string {
  if (placement !== 'VERTICAL_9_16') return '';
  const safe = getCreativeSafeRect(placement);
  return `This 9:16 image targets Facebook and Instagram Stories, not Reels. Keep all critical text, CTA, logos, faces and essential information inside x=${safe.left}..${safe.left + safe.width - 1}, y=${safe.top}..${safe.top + safe.height - 1}. Reserve the top 14%, bottom 35% and 6% on each side for platform overlays. Background and nonessential decoration may extend to the canvas edges. These are composition constraints, not visible borders. Human review must confirm placement safety before release.`;
}

export function formatCreativeLogoReservation(geometry: CreativeLogoGeometry): string {
  const rect = geometry.panel;
  return `Do not draw, imitate, typeset or retain a generated TRA logo. Keep the complete ${geometry.anchor} overlay rectangle x=${rect.left}..${rect.left + rect.width - 1}, y=${rect.top}..${rect.top + rect.height - 1} clear of text, faces, CTA and essential imagery. Continue the surrounding background naturally through this area. This is an invisible composition constraint: do not render a placeholder, box, panel, border, dashed outline, guide, coordinates, or labels such as "logo", "reserved", or "clear area". The original approved logo and its complete backing panel will be composited at exactly this geometry after generation; do not draw either yourself.`;
}
