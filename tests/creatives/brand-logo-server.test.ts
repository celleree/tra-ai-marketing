import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { compositeCreativeBrandLogo } from '@/lib/creatives/brand-logo.server';
import { CREATIVE_PLACEMENTS, CREATIVE_PLACEMENT_SPECS } from '@/lib/creatives/placements';

const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

describe('server logo composition', () => {
  it.each(CREATIVE_PLACEMENTS)('preserves %s dimensions and pixels outside the logo panel', async (placement) => {
    const { width, height } = CREATIVE_PLACEMENT_SPECS[placement];
    const source = await solid(width, height, '#112233');
    const output = await compositeCreativeBrandLogo(source, await solid(200, 100, '#ff0000'), placement);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width, height, channels: 4 });
    expect((await sharp(output).metadata()).format).toBe('png');
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
    expect(pixel(width - 1, height - 1)).toEqual([17, 34, 51, 255]);
    expect(pixel(0, 0)).toEqual([17, 34, 51, 255]);
    const left = (placement === 'VERTICAL_9_16' ? 70 : 0) + Math.round(width * 0.03) + Math.round(width * 0.014);
    const top = (placement === 'VERTICAL_9_16' ? 287 : 0) + Math.round(width * 0.03) + Math.round(height * 0.012);
    expect(pixel(left + 2, top + 2)).toEqual([255, 0, 0, 255]);
    if (placement === 'VERTICAL_9_16') {
      // Every changed pixel, including the translucent panel, stays out of platform overlays.
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (x < 70 || x >= 1082 || y < 287 || y >= 1331) {
            const offset = (y * width + x) * 4;
            if (data[offset] !== 17 || data[offset + 1] !== 34 || data[offset + 2] !== 51) {
              throw new Error(`Logo composition entered Stories overlay area at ${x},${y}`);
            }
          }
        }
      }
    }
  });

  it('preserves a tall logo aspect ratio and transparent artwork', async () => {
    const logo = await sharp(await solid(100, 200, '#00000000')).composite([
      { input: await solid(50, 100, '#ff0000'), left: 25, top: 50 },
    ]).png().toBuffer();
    const output = await compositeCreativeBrandLogo(await solid(1024, 1024, '#000000'), logo, 'SQUARE_1_1');
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const red: Array<[number, number]> = [];
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] > 250 && data[i + 1] < 5 && data[i + 2] < 5) red.push([x, y]);
      }
    }
    expect(red.length).toBeGreaterThan(0);
    const redWidth = Math.max(...red.map(([x]) => x)) - Math.min(...red.map(([x]) => x)) + 1;
    const redHeight = Math.max(...red.map(([, y]) => y)) - Math.min(...red.map(([, y]) => y)) + 1;
    expect(redWidth / redHeight).toBeCloseTo(0.5, 1);
    // Transparent logo corners reveal the white panel rather than an opaque black fill.
    const transparentCorner = ((43 + 2) * 1024 + 45 + 2) * info.channels;
    expect(data[transparentCorner]).toBeGreaterThan(230);
  });

  it('rejects an undecodable logo and a placement mismatch', async () => {
    const image = await solid(1024, 1024, '#112233');
    await expect(compositeCreativeBrandLogo(image, Buffer.from('invalid'), 'SQUARE_1_1')).rejects.toThrow();
    await expect(compositeCreativeBrandLogo(image, await solid(100, 100, '#ff0000'), 'PORTRAIT_4_5')).rejects.toThrow('dimensions');
  });
});
