import type { ImageFingerprint } from './fingerprint';
export function fingerprintDistance(a: ImageFingerprint, b: ImageFingerprint): number | null {
  if (Math.abs(a.width / a.height - b.width / b.height) > 0.15) return null;
  const bits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  return [...a.dHash].reduce((total, digit, index) => total + bits[parseInt(digit, 16) ^ parseInt(b.dHash[index], 16)], 0);
}
export function visualSimilarity(a: ImageFingerprint, b: ImageFingerprint) {
  if (a.pixelSha256 === b.pixelSha256) return { kind: 'identical-pixels' as const, distance: 0 };
  const distance = fingerprintDistance(a, b);
  return distance !== null && distance <= 6 ? { kind: 'possible-visual-variant' as const, distance } : null;
}
