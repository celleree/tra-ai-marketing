import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { validateGeneratedCreativeImage } from '@/lib/creatives/generated-image-validation';
import { CREATIVE_PLACEMENTS, CREATIVE_PLACEMENT_SPECS } from '@/lib/creatives/placements';

const pixels = (width: number, height: number) => sharp({
  create: { width, height, channels: 3, background: '#123047' },
});

describe('generated image technical validation', () => {
  it.each(CREATIVE_PLACEMENTS)('accepts a fully decodable %s PNG', async (placement) => {
    const { width, height } = CREATIVE_PLACEMENT_SPECS[placement];
    await expect(validateGeneratedCreativeImage(await pixels(width, height).png().toBuffer(), placement)).resolves.toBeUndefined();
  });

  it('rejects a decodable image with the wrong placement dimensions', async () => {
    const buffer = await pixels(1024, 1024).png().toBuffer();
    await expect(validateGeneratedCreativeImage(buffer, 'PORTRAIT_4_5')).rejects.toThrow('1024x1280');
  });

  it('rejects a different output format', async () => {
    const buffer = await pixels(1024, 1024).jpeg().toBuffer();
    await expect(validateGeneratedCreativeImage(buffer, 'SQUARE_1_1')).rejects.toThrow('single PNG');
  });

  it('rejects empty and truncated PNG data instead of accepting a signature', async () => {
    const buffer = await pixels(1024, 1024).png().toBuffer();
    for (const invalid of [Buffer.alloc(0), buffer.subarray(0, 8), buffer.subarray(0, Math.floor(buffer.length / 2))]) {
      await expect(validateGeneratedCreativeImage(invalid, 'SQUARE_1_1')).rejects.toThrow('decoded');
    }
  });
});
