import type {
  CreativeAdCopy,
  CreativeCopy,
  CreativeImageCopy,
} from '@/lib/creatives/generated';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const parseCreativeAdCopy = (value: unknown): CreativeAdCopy | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.primaryText !== 'string' ||
    typeof value.headline !== 'string' ||
    typeof value.description !== 'string'
  ) {
    return null;
  }

  return {
    primaryText: value.primaryText,
    headline: value.headline,
    description: value.description,
  };
};

export const parseCreativeImageCopy = (
  value: unknown
): CreativeImageCopy | null => {
  if (!isRecord(value) || typeof value.headline !== 'string') return null;
  for (const key of [
    'shortSupport',
    'proofAttribution',
    'cta',
    'disclosure',
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  }

  return {
    headline: value.headline,
    ...(value.shortSupport !== undefined
      ? { shortSupport: value.shortSupport as string }
      : {}),
    ...(value.proofAttribution !== undefined
      ? { proofAttribution: value.proofAttribution as string }
      : {}),
    ...(value.cta !== undefined ? { cta: value.cta as string } : {}),
    ...(value.disclosure !== undefined
      ? { disclosure: value.disclosure as string }
      : {}),
  };
};

const adCopyMatches = (copy: CreativeCopy, adCopy: CreativeAdCopy) =>
  copy.primaryText === adCopy.primaryText &&
  copy.headline === adCopy.headline &&
  copy.description === adCopy.description;

export const parseCreativeCopyContract = (
  value: Record<string, unknown>
): {
  copy: CreativeCopy;
  adCopy?: CreativeAdCopy;
  imageCopy?: CreativeImageCopy;
} | null => {
  const copy = parseCreativeAdCopy(value.copy);
  if (!copy) return null;

  const adCopy =
    value.adCopy === undefined ? undefined : parseCreativeAdCopy(value.adCopy);
  if (value.adCopy !== undefined && !adCopy) return null;
  if (adCopy && !adCopyMatches(copy, adCopy)) return null;

  const imageCopy =
    value.imageCopy === undefined
      ? undefined
      : parseCreativeImageCopy(value.imageCopy);
  if (value.imageCopy !== undefined && !imageCopy) return null;

  return {
    copy,
    ...(adCopy ? { adCopy } : {}),
    ...(imageCopy ? { imageCopy } : {}),
  };
};

export const resolveCreativeAdCopy = (value: {
  copy: CreativeCopy;
  adCopy?: CreativeAdCopy;
}): CreativeAdCopy => value.adCopy ?? value.copy;
