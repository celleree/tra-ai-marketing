import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { analyzeFrameTechnicalQuality } from '@/lib/video/frame-technical-analysis';

const checkerboard = async () => {
  const data = Buffer.alloc(128 * 128 * 3);
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const value = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 210 : 40;
      data.fill(value, (y * 128 + x) * 3, (y * 128 + x + 1) * 3);
    }
  }
  return sharp(data, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
};

describe('candidate technical analysis', () => {
  it('ranks a sharp pattern above its blurred version and is deterministic', async () => {
    const original = await checkerboard();
    const blurred = await sharp(original).blur(4).png().toBuffer();
    const sharpMetrics = await analyzeFrameTechnicalQuality(original);
    const blurredMetrics = await analyzeFrameTechnicalQuality(blurred);
    expect(sharpMetrics.laplacianVariance).toBeGreaterThan(blurredMetrics.laplacianVariance);
    expect(sharpMetrics.qualityScore).toBeGreaterThan(blurredMetrics.qualityScore);
    expect(await analyzeFrameTechnicalQuality(original)).toEqual(sharpMetrics);
    expect(sharpMetrics.differenceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(sharpMetrics.qualityScore).toBeGreaterThan(0);
    expect(sharpMetrics.qualityScore).toBeLessThanOrEqual(1);
  });

  it.each([0, 255])('reports clipped flat %i frames without NaN scores', async (value) => {
    const image = await sharp({ create: { width: 32, height: 24, channels: 3,
      background: { r: value, g: value, b: value } } }).jpeg().toBuffer();
    const metrics = await analyzeFrameTechnicalQuality(image);
    expect(metrics.meanRgb).toEqual([value, value, value]);
    expect(metrics.meanLuminance).toBe(value);
    expect(metrics.laplacianVariance).toBe(0);
    expect(metrics.qualityScore).toBe(0);
    expect(metrics.darkFraction + metrics.lightFraction).toBe(1);
  });

  it('handles tiny greyscale input and preserves colour evidence for hash collisions', async () => {
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3,
      background: { r: 128, g: 128, b: 128 } } }).greyscale().png().toBuffer();
    expect((await analyzeFrameTechnicalQuality(tiny)).qualityScore).toBeCloseTo(0.15);
    const red = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer();
    const blue = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).png().toBuffer();
    const first = await analyzeFrameTechnicalQuality(red);
    const second = await analyzeFrameTechnicalQuality(blue);
    expect(first.differenceHash).toBe(second.differenceHash);
    expect(first.meanRgb).not.toEqual(second.meanRgb);
  });

  it('rejects undecodable bytes', async () => {
    await expect(analyzeFrameTechnicalQuality(Buffer.from('invalid'))).rejects.toThrow();
  });
});
