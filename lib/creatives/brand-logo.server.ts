import sharp from 'sharp';
import { CREATIVE_PLACEMENT_SPECS, type CreativePlacement } from '@/lib/creatives/placements';

// Match the existing browser compositor until all generation moves server-side.
// This reserves room for the uploaded artwork; it does not certify content or safe zones.
export async function compositeCreativeBrandLogo(
  image: Buffer,
  logo: Buffer,
  placement: CreativePlacement
): Promise<Buffer> {
  const { width, height } = CREATIVE_PLACEMENT_SPECS[placement];
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
  const scale = Math.min(width * 0.23 / logoMetadata.width, height * 0.085 / logoMetadata.height);
  const logoWidth = Math.max(1, Math.round(logoMetadata.width * scale));
  const logoHeight = Math.max(1, Math.round(logoMetadata.height * scale));
  const margin = Math.round(width * 0.03);
  const paddingX = Math.round(width * 0.014);
  const paddingY = Math.round(height * 0.012);
  const panelWidth = logoWidth + paddingX * 2;
  const panelHeight = logoHeight + paddingY * 2;
  const radius = Math.round(width * 0.012);
  const panel = Buffer.from(
    `<svg width="${panelWidth}" height="${panelHeight}"><rect width="${panelWidth}" height="${panelHeight}" rx="${radius}" fill="white" fill-opacity="0.94"/></svg>`
  );
  const resizedLogo = await sharp(orientedLogo).resize(logoWidth, logoHeight, { fit: 'fill' }).png().toBuffer();
  return sharp(image).composite([
    { input: panel, left: margin, top: margin },
    { input: resizedLogo, left: margin + paddingX, top: margin + paddingY },
  ]).png().toBuffer();
}
