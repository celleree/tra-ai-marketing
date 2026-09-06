import sharp from 'sharp';

export interface FrameTechnicalAnalysis {
  version: 1;
  differenceHash: string;
  meanRgb: [number, number, number];
  meanLuminance: number;
  luminanceDeviation: number;
  laplacianVariance: number;
  darkFraction: number;
  lightFraction: number;
  qualityScore: number;
}

// Relative technical measurements, not aesthetic/semantic judgement or approval.
// Normalize spatial scale so differently sized frames can be compared.
export const analyzeFrameTechnicalQuality = async (bytes: Buffer): Promise<FrameTechnicalAnalysis> => {
  const { data: rgb, info } = await sharp(bytes, { limitInputPixels: 40_000_000 })
    .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  const grey = Buffer.alloc(pixels);
  const channelSums = [0, 0, 0];
  let sum = 0;
  let sumSquares = 0;
  let dark = 0;
  let light = 0;
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * info.channels;
    for (let channel = 0; channel < 3; channel += 1) channelSums[channel] += rgb[offset + channel];
    const value = Math.round(0.2126 * rgb[offset] + 0.7152 * rgb[offset + 1] + 0.0722 * rgb[offset + 2]);
    grey[i] = value;
    sum += value;
    sumSquares += value * value;
    if (value <= 8) dark += 1;
    if (value >= 247) light += 1;
  }
  let edgeSum = 0;
  let edgeSquares = 0;
  let edgeCount = 0;
  for (let y = 1; y < info.height - 1; y += 1) {
    for (let x = 1; x < info.width - 1; x += 1) {
      const i = y * info.width + x;
      const edge = grey[i - 1] + grey[i + 1] + grey[i - info.width] + grey[i + info.width] - 4 * grey[i];
      edgeSum += edge;
      edgeSquares += edge * edge;
      edgeCount += 1;
    }
  }
  const laplacianVariance = edgeCount ? Math.max(0, edgeSquares / edgeCount - (edgeSum / edgeCount) ** 2) : 0;
  const meanLuminance = sum / pixels;
  const luminanceDeviation = Math.sqrt(Math.max(0, sumSquares / pixels - meanLuminance ** 2));
  const tiny = await sharp(grey, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize(9, 8, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
  let differenceHash = '';
  for (let y = 0; y < 8; y += 1) {
    let row = 0;
    for (let x = 0; x < 8; x += 1) row = (row << 1) | Number(tiny[y * 9 + x] > tiny[y * 9 + x + 1]);
    differenceHash += row.toString(16).padStart(2, '0');
  }
  const darkFraction = dark / pixels;
  const lightFraction = light / pixels;
  // Versioned heuristic: retain the raw metrics so later tuning is inspectable.
  const qualityScore = 0.6 * laplacianVariance / (laplacianVariance + 100)
    + 0.25 * luminanceDeviation / (luminanceDeviation + 32)
    + 0.15 * (1 - darkFraction - lightFraction);
  return {
    version: 1, differenceHash,
    meanRgb: channelSums.map((value) => value / pixels) as [number, number, number],
    meanLuminance, luminanceDeviation, laplacianVariance, darkFraction, lightFraction, qualityScore,
  };
};
