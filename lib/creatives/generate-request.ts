import {
  CREATIVE_FORMATS,
  isCreativeFormat,
  type CreativeFormatId,
} from '@/lib/creative-formats';

export type GenerateFormatMode = 'diverse' | 'specific';

export type GenerateCreativeRequest = {
  mediaId: string;
  context: string;
  variationCount: number;
  formatMode?: GenerateFormatMode;
  primaryFormats?: CreativeFormatId[];
  allowSecondaryFormats?: boolean;
};

export type ValidGenerateCreativeRequest = {
  mediaId: string;
  context: string;
  variationCount: number;
  formatMode: GenerateFormatMode;
  primaryFormats: CreativeFormatId[];
  allowSecondaryFormats: boolean;
};

export type PlannedCreativeFormat = {
  index: number;
  primaryFormat: CreativeFormatId;
  secondaryFormat?: CreativeFormatId;
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
  const formatMode: GenerateFormatMode =
    body.formatMode === 'specific' ? 'specific' : 'diverse';
  const allowSecondaryFormats =
    typeof body.allowSecondaryFormats === 'boolean'
      ? body.allowSecondaryFormats
      : true;

  if (!mediaId) {
    return { success: false, error: 'mediaId is required' };
  }

  if (
    !Number.isInteger(variationCount) ||
    variationCount < 1 ||
    variationCount > 12
  ) {
    return {
      success: false,
      error: 'variationCount must be an integer between 1 and 12',
    };
  }

  const rawPrimaryFormats = Array.isArray(body.primaryFormats)
    ? body.primaryFormats
    : [];
  const primaryFormats = rawPrimaryFormats
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(isCreativeFormat);

  const uniquePrimaryFormats = [...new Set(primaryFormats)];

  if (formatMode === 'specific' && uniquePrimaryFormats.length === 0) {
    return {
      success: false,
      error: "At least one primary format is required when formatMode is 'specific'",
    };
  }

  return {
    success: true,
    data: {
      mediaId,
      context,
      variationCount,
      formatMode,
      primaryFormats: uniquePrimaryFormats,
      allowSecondaryFormats,
    },
  };
}

export function buildCreativeFormatPlan(
  request: ValidGenerateCreativeRequest
): PlannedCreativeFormat[] {
  const available = [...CREATIVE_FORMATS];
  const pool =
    request.formatMode === 'specific' && request.primaryFormats.length > 0
      ? request.primaryFormats
      : available;

  const plan: PlannedCreativeFormat[] = [];

  for (let index = 0; index < request.variationCount; index += 1) {
    const primaryFormat = pool[index % pool.length];
    let secondaryFormat: CreativeFormatId | undefined;

    if (
      request.allowSecondaryFormats &&
      available.length > 1 &&
      index % 2 === 1
    ) {
      const secondaryCandidates = available.filter(
        (format) => format !== primaryFormat
      );
      secondaryFormat =
        secondaryCandidates[index % secondaryCandidates.length];
    }

    plan.push({
      index: index + 1,
      primaryFormat,
      secondaryFormat,
    });
  }

  return plan;
}
