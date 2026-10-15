import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { fingerprintImage, fingerprintDistance, visualSimilarity } from '@/lib/discovery/fingerprint';
describe('deterministic visual fingerprints with local images', () => {
  it('recognizes identical pixels in differently encoded PNG files', async () => {
    const image = sharp({ create: { width: 40, height: 40, channels: 3, background: '#31a9f2' } });
    const a = await fingerprintImage(await image.clone().png({ compressionLevel: 0 }).toBuffer()), b = await fingerprintImage(await image.clone().png({ compressionLevel: 9 }).toBuffer());
    expect(a.byteSha256).not.toBe(b.byteSha256); expect(a.pixelSha256).toBe(b.pixelSha256); expect(visualSimilarity(a, b)?.kind).toBe('identical-pixels');
  });
  it('flags a cheap perceptual near match while preserving uncertainty and rejecting unlike aspect ratios', async () => {
    const pixels = Buffer.alloc(64 * 64 * 3);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let channel = 0; channel < 3; channel++) pixels[(y * 64 + x) * 3 + channel] = x * 3;
    const image = sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } });
    const a = await fingerprintImage(await image.clone().png().toBuffer()), b = await fingerprintImage(await image.clone().resize(32, 32).jpeg({ quality: 80 }).toBuffer());
    expect(a.pixelSha256).not.toBe(b.pixelSha256); expect(fingerprintDistance(a, b)).toBeLessThanOrEqual(6); expect(visualSimilarity(a, b)?.kind).toBe('possible-visual-variant');
    expect(fingerprintDistance(a, { ...b, width: 100, height: 10 })).toBeNull();
  });
  it('refuses corrupt images instead of fingerprinting file names or metadata', async () => { await expect(fingerprintImage(Buffer.from('not an image'))).rejects.toThrow(); });
});
