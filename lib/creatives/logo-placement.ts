import { CREATIVE_PLACEMENT_SPECS, isCreativePlacement, type CreativePlacement } from '@/lib/creatives/placements';
import { getCreativeSafeRect } from '@/lib/creatives/safe-zones';
import type { LayoutBlueprint, LayoutRegion } from '@/lib/layouts/blueprint';

export const CREATIVE_LOGO_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

export type CreativeLogoAnchor = (typeof CREATIVE_LOGO_ANCHORS)[number];
export type CreativeLogoRect = { left: number; top: number; width: number; height: number };
export type CreativeLogoGeometry = {
  placement: CreativePlacement;
  anchor: CreativeLogoAnchor;
  panel: CreativeLogoRect;
  artwork: CreativeLogoRect;
};
export type CreativeLogoPlacementContext = {
  placement: CreativePlacement;
  sourceWidth: number;
  sourceHeight: number;
};

export const isCreativeLogoAnchor = (value: unknown): value is CreativeLogoAnchor =>
  typeof value === 'string' && CREATIVE_LOGO_ANCHORS.includes(value as CreativeLogoAnchor);
export const isCreativeLogoPlacementContext = (value: unknown): value is CreativeLogoPlacementContext => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return Object.keys(context).length === 3 && isCreativePlacement(context.placement)
    && Number.isSafeInteger(context.sourceWidth) && (context.sourceWidth as number) > 0
    && Number.isSafeInteger(context.sourceHeight) && (context.sourceHeight as number) > 0;
};

const anchorForRegion = (region: LayoutRegion): CreativeLogoAnchor => {
  const centerX = region.xPct + region.widthPct / 2;
  const bottom = region.yPct + region.heightPct / 2 >= 50;
  if (bottom) return centerX < 50 ? 'bottom-left' : 'bottom-right';
  if (centerX < 34) return 'top-left';
  if (centerX > 66) return 'top-right';
  return 'top-center';
};

const FALLBACK_CANDIDATE_RECTS: Record<CreativeLogoAnchor, CreativeLogoRect> = {
  'top-left': { left: 3, top: 3, width: 26, height: 11 },
  'top-center': { left: 37, top: 3, width: 26, height: 11 },
  'top-right': { left: 71, top: 3, width: 26, height: 11 },
  'bottom-left': { left: 3, top: 86, width: 26, height: 11 },
  'bottom-right': { left: 71, top: 86, width: 26, height: 11 },
};
const BLOCKING_ROLES = new Set(['HEADLINE', 'SUPPORTING_TEXT', 'CTA', 'HUMAN_PLACEHOLDER']);
const overlapArea = (left: CreativeLogoRect, right: LayoutRegion) =>
  Math.max(0, Math.min(left.left + left.width, right.xPct + right.widthPct) - Math.max(left.left, right.xPct))
  * Math.max(0, Math.min(left.top + left.height, right.yPct + right.heightPct) - Math.max(left.top, right.yPct));

/** A selected layout owns logo placement when it supplies relevant geometry. */
export function resolveLayoutAwareLogoAnchor(
  plannerAnchor: CreativeLogoAnchor,
  blueprint?: LayoutBlueprint,
  context?: CreativeLogoPlacementContext,
): CreativeLogoAnchor {
  if (!blueprint) return plannerAnchor;
  const placeholder = blueprint.regions.find(region => region.role === 'LOGO_PLACEHOLDER');
  if (placeholder) return anchorForRegion(placeholder);
  const blockers = blueprint.regions.filter(region => BLOCKING_ROLES.has(region.role));
  if (!blockers.length) return plannerAnchor;
  const candidateRects = context
    ? Object.fromEntries(CREATIVE_LOGO_ANCHORS.map(anchor => {
        const panel = resolveCreativeLogoGeometry(
          context.placement, anchor, context.sourceWidth, context.sourceHeight,
        ).panel;
        const canvas = CREATIVE_PLACEMENT_SPECS[context.placement];
        return [anchor, {
          left: panel.left * 100 / canvas.width,
          top: panel.top * 100 / canvas.height,
          width: panel.width * 100 / canvas.width,
          height: panel.height * 100 / canvas.height,
        }];
      })) as Record<CreativeLogoAnchor, CreativeLogoRect>
    : FALLBACK_CANDIDATE_RECTS;
  const scores = CREATIVE_LOGO_ANCHORS.map(anchor => ({
    anchor,
    score: blockers.reduce((total, region) => total + overlapArea(candidateRects[anchor], region), 0),
  }));
  const minimum = Math.min(...scores.map(candidate => candidate.score));
  return scores.some(candidate => candidate.anchor === plannerAnchor && candidate.score === minimum)
    ? plannerAnchor
    : scores.find(candidate => candidate.score === minimum)!.anchor;
}

export function resolveCreativeLogoGeometry(
  placement: CreativePlacement,
  anchor: CreativeLogoAnchor,
  sourceWidth: number,
  sourceHeight: number,
): CreativeLogoGeometry {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('The TRA logo has invalid dimensions.');
  }
  const safe = getCreativeSafeRect(placement);
  const { width: canvasWidth, height: canvasHeight } = CREATIVE_PLACEMENT_SPECS[placement];
  const scale = Math.min(canvasWidth * 0.23 / sourceWidth, canvasHeight * 0.085 / sourceHeight);
  const artworkWidth = Math.max(1, Math.round(sourceWidth * scale));
  const artworkHeight = Math.max(1, Math.round(sourceHeight * scale));
  const margin = Math.round(canvasWidth * 0.03);
  const paddingX = Math.round(canvasWidth * 0.014);
  const paddingY = Math.round(canvasHeight * 0.012);
  const panelWidth = artworkWidth + paddingX * 2;
  const panelHeight = artworkHeight + paddingY * 2;
  const left = anchor === 'top-center'
    ? safe.left + Math.round((safe.width - panelWidth) / 2)
    : anchor.endsWith('right')
      ? safe.left + safe.width - margin - panelWidth
      : safe.left + margin;
  const top = anchor.startsWith('bottom')
    ? safe.top + safe.height - margin - panelHeight
    : safe.top + margin;
  return {
    placement,
    anchor,
    panel: { left, top, width: panelWidth, height: panelHeight },
    artwork: { left: left + paddingX, top: top + paddingY, width: artworkWidth, height: artworkHeight },
  };
}
