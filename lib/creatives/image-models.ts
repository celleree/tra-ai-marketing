export const CREATIVE_IMAGE_MODELS = [
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const;

export type CreativeImageModel = (typeof CREATIVE_IMAGE_MODELS)[number];

export const DEFAULT_CREATIVE_IMAGE_MODEL: CreativeImageModel =
  'gpt-image-2.5-flare';

export const CREATIVE_IMAGE_MODEL_LABELS: Record<CreativeImageModel, string> = {
  'gpt-image-2.5-flare': 'Flare',
  'gpt-image-2.5-sunburst': 'Sunburst',
};

export const isCreativeImageModel = (
  value: unknown
): value is CreativeImageModel =>
  typeof value === 'string' &&
  CREATIVE_IMAGE_MODELS.includes(value as CreativeImageModel);
