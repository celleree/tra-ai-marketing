import sharp, { type Sharp, type Metadata } from 'sharp';
import { CREATIVE_PLACEMENT_SPECS, type CreativePlacement } from '@/lib/creatives/placements';

const MAX_GENERATED_PIXELS = Math.max(
  ...Object.values(CREATIVE_PLACEMENT_SPECS).map(({ width, height }) => width * height)
);
export class GeneratedImageValidationError extends Error {}
const decodeError = () => new GeneratedImageValidationError('Generated image could not be fully decoded. Regenerate this creative.');

// Technical output checks only; visual quality and compliance still need review.
export async function validateGeneratedCreativeImage(buffer: Buffer, placement: CreativePlacement): Promise<void> {
  const expected = CREATIVE_PLACEMENT_SPECS[placement];
  let decoder: Sharp;
  let metadata: Metadata;
  try {
    decoder = sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_GENERATED_PIXELS });
    metadata = await decoder.metadata();
  } catch {
    throw decodeError();
  }
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) {
    throw new GeneratedImageValidationError('Generated image must be a single PNG. Regenerate this creative.');
  }
  if (metadata.width !== expected.width || metadata.height !== expected.height) {
    throw new GeneratedImageValidationError(`Generated image must be ${expected.width}x${expected.height} for ${expected.aspectRatio}. Regenerate this creative.`);
  }
  try {
    // Reading headers alone can accept a truncated pixel stream.
    await decoder.raw().toBuffer();
  } catch {
    throw decodeError();
  }
}
