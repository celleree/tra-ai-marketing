import {
  CREATIVE_CATEGORIES,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import type { CreativeFormatId } from '@/lib/creative-formats';
import {
  isCreativePlacement,
  type CreativePlacement,
} from '@/lib/creatives/placements';
import {
  buildCreativeCompanyContext,
  formatCreativeCompanyContext,
  normalizeRuntimeCompanyProfile,
  type RuntimeCompanyProfileSnapshot,
} from '@/lib/company/creative-context';
import type { CreativeSourceSelection } from '@/lib/media/types';
import { parseCreativeSourceSelection } from '@/lib/media/source-contract';
import {
  parseGenerateVideoFrameSelection,
  type GenerateVideoFrameSelection,
} from '@/lib/video/generation-selection-contract';

export type GenerateCreativeRequest = {
  sourceAssets?: CreativeSourceSelection[];
  brandLogoMediaId?: string;
  brandColors?: string[];
  brandFontNames?: string[];
  companyProfile?: RuntimeCompanyProfileSnapshot;
  videoFrameSelection?: GenerateVideoFrameSelection;
  placement?: CreativePlacement;
  context: string;
  variationCount: number;
};

export type ValidGenerateCreativeRequest = Omit<
  GenerateCreativeRequest,
  'sourceAssets' | 'placement'
> & {
  sourceAssets: CreativeSourceSelection[];
  placement: CreativePlacement;
};

export type PlannedCreative = {
  index: number;
  category: CreativeCategoryId;
  format: CreativeFormatId;
  primaryFormat: CreativeFormatId;
  secondaryFormat?: CreativeFormatId;
};

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

const SAFE_MEDIA_ID = /^media_[a-f0-9]{32}$/;
const SAFE_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

const stringArray = (value: unknown, max: number) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, max)
    : [];

export function validateGenerateCreativeRequest(input: unknown):
  | { success: true; data: ValidGenerateCreativeRequest }
  | { success: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { success: false, error: 'Invalid request body' };
  }

  const body = input as Record<string, unknown>;

  if (body.mediaId !== undefined || body.uploadMode !== undefined) {
    return {
      success: false,
      error: 'Use sourceAssets with explicit source roles instead of mediaId/uploadMode',
    };
  }

  const sourceValues = Array.isArray(body.sourceAssets) ? body.sourceAssets : [];
  const videoFrameSelection =
    body.videoFrameSelection === undefined
      ? undefined
      : parseGenerateVideoFrameSelection(body.videoFrameSelection);
  const placement =
    body.placement === undefined ? 'SQUARE_1_1' : body.placement;
  const brandLogoMediaId =
    typeof body.brandLogoMediaId === 'string'
      ? body.brandLogoMediaId.trim()
      : '';
  const brandColors = stringArray(body.brandColors, 6);
  const brandFontNames = stringArray(body.brandFontNames, 6).map((name) =>
    name.slice(0, 500)
  );
  const companyProfile = normalizeRuntimeCompanyProfile(body.companyProfile);
  const userContext = typeof body.context === 'string' ? body.context.trim() : '';
  const variationCount =
    typeof body.variationCount === 'number'
      ? body.variationCount
      : Number(body.variationCount);

  if (body.sourceAssets !== undefined && !Array.isArray(body.sourceAssets)) {
    return { success: false, error: 'sourceAssets must be an array' };
  }

  if (body.videoFrameSelection !== undefined && !videoFrameSelection) {
    return {
      success: false,
      error:
        'videoFrameSelection must contain a valid libraryId, sourceVideoContentHash, and 1 to 3 unique frameIds',
    };
  }

  if (!isCreativePlacement(placement)) {
    return { success: false, error: 'placement is unsupported' };
  }

  if (
    body.companyProfile !== undefined &&
    (!body.companyProfile ||
      typeof body.companyProfile !== 'object' ||
      Array.isArray(body.companyProfile))
  ) {
    return { success: false, error: 'companyProfile must be an object' };
  }

  const sourceAssets: CreativeSourceSelection[] = [];
  for (const sourceValue of sourceValues) {
    const validated = parseCreativeSourceSelection(sourceValue);
    if (!validated.success) return validated;
    sourceAssets.push(validated.data);
  }

  if (new Set(sourceAssets.map((source) => source.mediaId)).size !== sourceAssets.length) {
    return { success: false, error: 'sourceAssets contains duplicate media IDs' };
  }

  if (
    videoFrameSelection &&
    (sourceAssets.length !== 1 || sourceAssets[0].role !== 'TRA_VIDEO')
  ) {
    return {
      success: false,
      error: 'videoFrameSelection requires exactly one TRA_VIDEO source asset',
    };
  }

  if (!userContext) {
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

  if (brandLogoMediaId && !SAFE_MEDIA_ID.test(brandLogoMediaId)) {
    return {
      success: false,
      error: 'brandLogoMediaId is invalid',
    };
  }

  if (brandColors.some((color) => !SAFE_HEX_COLOR.test(color))) {
    return { success: false, error: 'brandColors contains an invalid color' };
  }

  const companyContext = formatCreativeCompanyContext(
    buildCreativeCompanyContext(companyProfile)
  );
  const context = `USER CREATIVE DIRECTION:\n${userContext}\n\n${companyContext}`;

  return {
    success: true,
    data: {
      sourceAssets,
      placement,
      ...(brandLogoMediaId ? { brandLogoMediaId } : {}),
      ...(brandColors.length ? { brandColors } : {}),
      ...(brandFontNames.length ? { brandFontNames } : {}),
      ...(companyProfile ? { companyProfile } : {}),
      ...(videoFrameSelection ? { videoFrameSelection } : {}),
      context,
      variationCount,
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
