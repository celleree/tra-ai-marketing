export const PREFERRED_CREATIVE_IMAGE_MODEL = 'gpt-image-2.5-sunburst' as const;
export const FALLBACK_CREATIVE_IMAGE_MODEL = 'gpt-image-2.5-flare' as const;

export type CreativeImageModel =
  | typeof PREFERRED_CREATIVE_IMAGE_MODEL
  | typeof FALLBACK_CREATIVE_IMAGE_MODEL;

export const CREATIVE_IMAGE_OPERATION_TYPES = [
  'PROMPT_GENERATION',
  'LAYOUT_REFERENCE_GENERATION',
  'TRA_REFERENCE_GENERATION',
  'TRA_VIDEO_FRAME_GENERATION',
  'EDIT',
  'REGENERATE',
  'VARIATION',
  'PLACEMENT',
] as const;

export type CreativeImageOperationType =
  (typeof CREATIVE_IMAGE_OPERATION_TYPES)[number];

export type CreativeImageRouting = {
  operationType: CreativeImageOperationType;
  preferredModel: CreativeImageModel;
  actualModel: CreativeImageModel;
  fallbackUsed: boolean;
  fallbackFromModel: CreativeImageModel | null;
  fallbackReason: string | null;
};

export const isCreativeImageModel = (
  value: unknown
): value is CreativeImageModel =>
  value === PREFERRED_CREATIVE_IMAGE_MODEL ||
  value === FALLBACK_CREATIVE_IMAGE_MODEL;

export const isCreativeImageOperationType = (
  value: unknown
): value is CreativeImageOperationType =>
  typeof value === 'string' &&
  CREATIVE_IMAGE_OPERATION_TYPES.includes(value as CreativeImageOperationType);
