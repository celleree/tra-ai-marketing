import sharp from 'sharp';
import { createHash } from 'node:crypto';
export { fingerprintDistance, visualSimilarity } from './similarity';
export type ImageFingerprint = { byteSha256: string; pixelSha256: string; dHash: string; width: number; height: number };
export async function fingerprintImage(bytes: Buffer): Promise<ImageFingerprint> {
  const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'error' }).rotate().ensureAlpha();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  const pixels = await image.clone().flatten({ background: '#ffffff' }).removeAlpha().resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  let dHash = '';
  for (let row = 0; row < 8; row++) {
    let octet = 0; for (let column = 0; column < 8; column++) octet = (octet << 1) | Number(pixels[row * 9 + column] > pixels[row * 9 + column + 1]);
    dHash += octet.toString(16).padStart(2, '0');
  }
  return { byteSha256: createHash('sha256').update(bytes).digest('hex'), pixelSha256: createHash('sha256').update(`${info.width}x${info.height}|`).update(data).digest('hex'), dHash, width: info.width, height: info.height };
}
