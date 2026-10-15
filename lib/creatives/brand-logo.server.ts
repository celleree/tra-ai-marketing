import sharp from 'sharp';
import { CREATIVE_PLACEMENT_SPECS, type CreativePlacement } from '@/lib/creatives/placements';
import {
  resolveCreativeLogoGeometry,
  type CreativeLogoAnchor,
  type CreativeLogoGeometry,
  type CreativeLogoPlacementContext,
} from '@/lib/creatives/logo-placement';

export async function resolveCreativeBrandLogoPlacementContext(
  logo: Buffer,
  placement: CreativePlacement,
): Promise<CreativeLogoPlacementContext> {
  const orientedLogo = await sharp(logo).rotate().png().toBuffer();
  const metadata = await sharp(orientedLogo).metadata();
  if (!metadata.width || !metadata.height) throw new Error('The TRA logo has invalid dimensions.');
  return { placement, sourceWidth: metadata.width, sourceHeight: metadata.height };
}

export async function resolveCreativeBrandLogoGeometry(
  logo: Buffer,
  placement: CreativePlacement,
  anchor: CreativeLogoAnchor,
): Promise<CreativeLogoGeometry> {
  const context = await resolveCreativeBrandLogoPlacementContext(logo, placement);
  return resolveCreativeLogoGeometry(placement, anchor, context.sourceWidth, context.sourceHeight);
}

// Place original artwork inside the placement-safe area. Other image content still needs human review.
export async function compositeCreativeBrandLogo(
  image: Buffer,
  logo: Buffer,
  geometry: CreativeLogoGeometry,
): Promise<Buffer> {
  const { width, height } = CREATIVE_PLACEMENT_SPECS[geometry.placement];
  const imageMetadata = await sharp(image).metadata();
  if (imageMetadata.width !== width || imageMetadata.height !== height) {
    throw new Error('The creative dimensions do not match the requested placement.');
  }

  // Auto-orient before measuring so uploaded EXIF orientation matches browser display.
  const orientedLogo = await sharp(logo).rotate().png().toBuffer();
  const logoMetadata = await sharp(orientedLogo).metadata();
  if (!logoMetadata.width || !logoMetadata.height) {
    throw new Error('The TRA logo has invalid dimensions.');
  }
  const { panel: panelRect, artwork } = geometry;
  if (artwork.width <= 0 || artwork.height <= 0 || panelRect.width <= 0 || panelRect.height <= 0
    || panelRect.left < 0 || panelRect.top < 0 || panelRect.left + panelRect.width > width
    || panelRect.top + panelRect.height > height) throw new Error('The TRA logo geometry is invalid.');
  const radius = Math.round(width * 0.012);
  const panel = Buffer.from(
    `<svg width="${panelRect.width}" height="${panelRect.height}"><rect width="${panelRect.width}" height="${panelRect.height}" rx="${radius}" fill="white" fill-opacity="0.94"/></svg>`
  );
  const resizedLogo = await sharp(orientedLogo).resize(artwork.width, artwork.height, { fit: 'fill' }).png().toBuffer();
  return sharp(image).composite([
    { input: panel, left: panelRect.left, top: panelRect.top },
    { input: resizedLogo, left: artwork.left, top: artwork.top },
  ]).png().toBuffer();
}

/** Remove only the known deterministic overlay rectangle before provider editing. */
export async function eraseCreativeBrandLogo(
  image: Buffer,
  geometry: CreativeLogoGeometry,
): Promise<Buffer> {
  const { panel } = geometry;
  const cutout = Buffer.from(`<svg width="${panel.width}" height="${panel.height}"><rect width="${panel.width}" height="${panel.height}" fill="black"/></svg>`);
  return sharp(image).ensureAlpha().composite([
    { input: cutout, left: panel.left, top: panel.top, blend: 'dest-out' },
  ]).png().toBuffer();
}
