'use client';

const HEX_COLOR = /#[0-9a-f]{6}\b/gi;

const toHex = (value: number) => value.toString(16).padStart(2, '0');

const colorDistance = (a: [number, number, number], b: [number, number, number]) =>
  Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
  );

const hexToRgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

export const parseBrandColors = (value: string) =>
  Array.from(new Set((value.match(HEX_COLOR) || []).map((color) => color.toUpperCase()))).slice(
    0,
    6
  );

export const formatBrandColors = (colors: string[]) =>
  colors.map((color, index) => `${index === 0 ? 'Primary' : `Color ${index + 1}`}: ${color}`).join('\n');

export async function extractLogoPalette(file: Blob): Promise<string[]> {
  const bitmap = await createImageBitmap(file);

  try {
    const maxDimension = 160;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return [];

    context.clearRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const counts = new Map<string, { count: number; rgb: [number, number, number] }>();
    let includedPixels = 0;

    for (let index = 0; index < pixels.length; index += 16) {
      const alpha = pixels[index + 3];
      if (alpha < 80) continue;

      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const quantize = (value: number) => Math.min(255, Math.round(value / 24) * 24);
      const rgb: [number, number, number] = [
        quantize(red),
        quantize(green),
        quantize(blue),
      ];
      const key = rgb.join(',');
      const existing = counts.get(key);
      counts.set(key, { count: (existing?.count || 0) + 1, rgb });
      includedPixels += 1;
    }

    if (!includedPixels) return [];

    const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
    const selected: string[] = [];

    for (const candidate of ranked) {
      const [red, green, blue] = candidate.rgb;
      const brightness = (red + green + blue) / 3;
      const share = candidate.count / includedPixels;

      if (brightness > 244 && share > 0.35) continue;

      const hex = `#${toHex(red)}${toHex(green)}${toHex(blue)}`.toUpperCase();
      const rgb = hexToRgb(hex);
      if (selected.some((color) => colorDistance(hexToRgb(color), rgb) < 72)) {
        continue;
      }

      selected.push(hex);
      if (selected.length >= 5) break;
    }

    if (!selected.length && ranked[0]) {
      const [red, green, blue] = ranked[0].rgb;
      selected.push(`#${toHex(red)}${toHex(green)}${toHex(blue)}`.toUpperCase());
    }

    return selected;
  } finally {
    bitmap.close();
  }
}
