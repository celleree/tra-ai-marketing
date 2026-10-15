import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  compositeCreativeBrandLogo,
  eraseCreativeBrandLogo,
  resolveCreativeBrandLogoGeometry,
} from '@/lib/creatives/brand-logo.server';
import { CREATIVE_LOGO_ANCHORS } from '@/lib/creatives/logo-placement';
import { CREATIVE_PLACEMENTS, CREATIVE_PLACEMENT_SPECS } from '@/lib/creatives/placements';

const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

describe('server logo composition', () => {
  it.each(CREATIVE_PLACEMENTS.flatMap(placement => CREATIVE_LOGO_ANCHORS.map(anchor => [placement, anchor] as const)))
  ('composites actual official-logo pixels at %s %s with the resolved provider geometry', async (placement, anchor) => {
    const { width, height } = CREATIVE_PLACEMENT_SPECS[placement];
    const source = await solid(width, height, '#112233');
    const logo = await solid(200, 100, '#ff0000');
    const geometry = await resolveCreativeBrandLogoGeometry(logo, placement, anchor);
    const output = await compositeCreativeBrandLogo(source, logo, geometry);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
    expect(info).toMatchObject({ width, height, channels: 4 });
    expect((await sharp(output).metadata()).format).toBe('png');
    expect(pixel(0, 0)).toEqual([17, 34, 51, 255]);
    expect(pixel(geometry.artwork.left + 2, geometry.artwork.top + 2)).toEqual([255, 0, 0, 255]);
  });

  it('preserves a tall logo aspect ratio and transparent artwork', async () => {
    const logo = await sharp(await solid(100, 200, '#00000000')).composite([
      { input: await solid(50, 100, '#ff0000'), left: 25, top: 50 },
    ]).png().toBuffer();
    const geometry = await resolveCreativeBrandLogoGeometry(logo, 'SQUARE_1_1', 'top-center');
    const output = await compositeCreativeBrandLogo(await solid(1024, 1024, '#000000'), logo, geometry);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const red: Array<[number, number]> = [];
    for (let y = geometry.artwork.top; y < geometry.artwork.top + geometry.artwork.height; y += 1) {
      for (let x = geometry.artwork.left; x < geometry.artwork.left + geometry.artwork.width; x += 1) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] > 250 && data[i + 1] < 5 && data[i + 2] < 5) red.push([x, y]);
      }
    }
    const redWidth = Math.max(...red.map(([x]) => x)) - Math.min(...red.map(([x]) => x)) + 1;
    const redHeight = Math.max(...red.map(([, y]) => y)) - Math.min(...red.map(([, y]) => y)) + 1;
    expect(redWidth / redHeight).toBeCloseTo(0.5, 1);
    const corner = (geometry.artwork.top * info.width + geometry.artwork.left) * info.channels;
    expect(data[corner]).toBeGreaterThan(230);
  });

  it('measures and composites the auto-oriented official artwork', async () => {
    const exifRotated = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ff0000' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const geometry = await resolveCreativeBrandLogoGeometry(exifRotated, 'SQUARE_1_1', 'top-right');
    expect(geometry.artwork.width / geometry.artwork.height).toBeCloseTo(0.5, 1);
    const output = await compositeCreativeBrandLogo(await solid(1024, 1024, '#112233'), exifRotated, geometry);
    expect(await sharp(output).metadata()).toMatchObject({ width: 1024, height: 1024, format: 'png' });
  });

  it('erases exactly the known prior panel before revision editing', async () => {
    const logo = await solid(200, 100, '#ff0000');
    const geometry = await resolveCreativeBrandLogoGeometry(logo, 'SQUARE_1_1', 'bottom-right');
    const branded = await compositeCreativeBrandLogo(await solid(1024, 1024, '#112233'), logo, geometry);
    const erased = await eraseCreativeBrandLogo(branded, geometry);
    const { data, info } = await sharp(erased).raw().toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alpha(geometry.panel.left + 1, geometry.panel.top + 1)).toBe(0);
    expect(alpha(0, 0)).toBe(255);
  });

  it('rejects an undecodable logo and a placement mismatch', async () => {
    const image = await solid(1024, 1024, '#112233');
    await expect(resolveCreativeBrandLogoGeometry(Buffer.from('invalid'), 'SQUARE_1_1', 'top-left')).rejects.toThrow();
    const logo = await solid(100, 100, '#ff0000');
    const portrait = await resolveCreativeBrandLogoGeometry(logo, 'PORTRAIT_4_5', 'top-left');
    await expect(compositeCreativeBrandLogo(image, logo, portrait)).rejects.toThrow('dimensions');
  });
});
