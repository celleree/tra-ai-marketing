// Placement aspect ratios are independent of CreativeFormatId (ad presentation style).
export const CREATIVE_PLACEMENTS = ['SQUARE_1_1', 'PORTRAIT_4_5', 'VERTICAL_9_16'] as const;
export type CreativePlacement = (typeof CREATIVE_PLACEMENTS)[number];

export interface CreativePlacementSpec {
  aspectRatio: '1:1' | '4:5' | '9:16';
  width: number;
  height: number;
  providerSize: `${number}x${number}`;
}

// Exact ratios within GPT Image 2's documented custom-size constraints:
// https://developers.openai.com/api/docs/guides/image-generation
// These dimensions do not establish platform safe zones; those require a separate policy.
export const CREATIVE_PLACEMENT_SPECS: Readonly<Record<CreativePlacement, CreativePlacementSpec>> = {
  SQUARE_1_1: { aspectRatio: '1:1', width: 1024, height: 1024, providerSize: '1024x1024' },
  PORTRAIT_4_5: { aspectRatio: '4:5', width: 1024, height: 1280, providerSize: '1024x1280' },
  VERTICAL_9_16: { aspectRatio: '9:16', width: 1152, height: 2048, providerSize: '1152x2048' },
};

export function isCreativePlacement(value: unknown): value is CreativePlacement {
  return typeof value === 'string' && CREATIVE_PLACEMENTS.some((placement) => placement === value);
}

const PLACEMENT_RATIO_TOLERANCE = 0.01;

export function placementForImageDimensions(
  width: number,
  height: number
): CreativePlacement | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }

  const actualRatio = width / height;
  return CREATIVE_PLACEMENTS.find((placement) => {
    const [ratioWidth, ratioHeight] = CREATIVE_PLACEMENT_SPECS[placement].aspectRatio
      .split(':')
      .map(Number);
    const expectedRatio = ratioWidth / ratioHeight;
    return Math.abs(actualRatio - expectedRatio) / expectedRatio <= PLACEMENT_RATIO_TOLERANCE + Number.EPSILON;
  });
}
