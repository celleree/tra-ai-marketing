import {
  CREATIVE_CATEGORIES,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import type { CreativeFormatId } from '@/lib/creative-formats';

export type UploadMode = 'tra' | 'reference';

export type GenerateCreativeRequest = {
  mediaId?: string;
  context: string;
  variationCount: number;
  uploadMode?: UploadMode;
};

export type ValidGenerateCreativeRequest = Omit<
  GenerateCreativeRequest,
  'uploadMode'
> & {
  uploadMode: UploadMode;
};

export type PlannedCreative = {
  index: number;
  category: CreativeCategoryId;
  format: CreativeFormatId;
  primaryFormat: CreativeFormatId;
  secondaryFormat?: CreativeFormatId;
};

// Compatibility alias for the existing AI provider contract while the app
// transitions from format-led planning to category-led planning.
export type PlannedCreativeFormat = PlannedCreative;

const FORMAT_BY_CATEGORY: Record<CreativeCategoryId, CreativeFormatId> = {
  'customer-problems': 'direct-response',
  'desired-outcomes': 'direct-response',
  objections: 'educational',
  'testimonials-proof': 'proof',
  statistics: 'proof',
  comparisons: 'comparison-transformation',
  'price-offer-positioning': 'direct-response',
  'feature-led': 'educational',
  emotional: 'direct-response',
  educational: 'educational',
  'aspirational-lifestyle': 'direct-response',
  curiosity: 'educational',
  urgency: 'direct-response',
  'before-after': 'comparison-transformation',
  'customer-personas': 'native-social',
};

export function validateGenerateCreativeRequest(input: unknown):
  | { success: true; data: ValidGenerateCreativeRequest }
  | { success: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { success: false, error: 'Invalid request body' };
  }

  const body = input as Record<string, unknown>;
  const mediaId = typeof body.mediaId === 'string' ? body.mediaId.trim() : '';
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  const variationCount =
    typeof body.variationCount === 'number'
      ? body.variationCount
      : Number(body.variationCount);
  const uploadMode =
    typeof body.uploadMode === 'string' ? body.uploadMode.trim() : 'tra';

  if (!context) {
    return { success: false, error: 'context is required' };
  }

  if (
    !Number.isInteger(variationCount) ||
    variationCount < 2 ||
    variationCount > 30
  ) {
    return {
      success: false,
      error: 'variationCount must be an integer between 2 and 30',
    };
  }

  if (uploadMode !== 'tra' && uploadMode !== 'reference') {
    return {
      success: false,
      error: 'uploadMode must be either tra or reference',
    };
  }

  return {
    success: true,
    data: {
      ...(mediaId ? { mediaId } : {}),
      context,
      variationCount,
      uploadMode,
    },
  };
}

export function buildCreativePlan(
  request: ValidGenerateCreativeRequest,
  forcedCategory?: CreativeCategoryId
): PlannedCreative[] {
  return Array.from({ length: request.variationCount }, (_, offset) => {
    const category =
      forcedCategory || CREATIVE_CATEGORIES[offset % CREATIVE_CATEGORIES.length];
    const format = FORMAT_BY_CATEGORY[category];
    return {
      index: offset + 1,
      category,
      format,
      primaryFormat: format,
    };
  });
}

export const buildCreativeFormatPlan = buildCreativePlan;
