import type {
  CreativeAdCopy,
  CreativeCopy,
  CreativeImageCopy,
} from '@/lib/creatives/generated';

const MAX_MODERN_COPY_LENGTH = 1000;
const MODERN_COPY_KEYS = ['primaryText', 'headline', 'description'] as const;
const MODERN_IMAGE_COPY_KEYS = [
  'headline', 'shortSupport', 'proofAttribution', 'cta', 'disclosure',
] as const;
const OPTIONAL_IMAGE_COPY_KEYS = MODERN_IMAGE_COPY_KEYS.slice(1);
const MODERN_COPY_KEY_SET = new Set<string>(MODERN_COPY_KEYS);
const MODERN_IMAGE_COPY_KEY_SET = new Set<string>(MODERN_IMAGE_COPY_KEYS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
const isModernString = (value: unknown, nonblank = false) =>
  typeof value === 'string' &&
  value.length <= MAX_MODERN_COPY_LENGTH &&
  (!nonblank || value.trim().length > 0);

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

const parseModernAdCopy = (value: unknown): CreativeAdCopy | null => {
  const parsed = parseCreativeAdCopy(value);
  if (!parsed || !isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== MODERN_COPY_KEYS.length ||
    keys.some((key) => !MODERN_COPY_KEY_SET.has(key))
  ) return null;
  return isModernString(parsed.primaryText, true) &&
    isModernString(parsed.headline, true) &&
    isModernString(parsed.description) ? parsed : null;
};

const parseModernImageCopy = (value: unknown): CreativeImageCopy | null => {
  const parsed = parseCreativeImageCopy(value);
  if (
    !parsed ||
    !isRecord(value) ||
    Object.keys(value).some((key) => !MODERN_IMAGE_COPY_KEY_SET.has(key))
  ) return null;
  if (!isModernString(parsed.headline, true)) return null;
  for (const key of OPTIONAL_IMAGE_COPY_KEYS) {
    if (hasOwn(value, key) && !isModernString(value[key], true)) return null;
  }
  return parsed;
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
  const hasAdCopy = hasOwn(value, 'adCopy');
  const hasImageCopy = hasOwn(value, 'imageCopy');

  if (!hasAdCopy && !hasImageCopy) {
    const copy = parseCreativeAdCopy(value.copy);
    return copy ? { copy } : null;
  }

  if (!hasAdCopy || !hasImageCopy) return null;

  const copy = parseModernAdCopy(value.copy);
  const adCopy = parseModernAdCopy(value.adCopy);
  const imageCopy = parseModernImageCopy(value.imageCopy);
  if (!copy || !adCopy || !imageCopy || !adCopyMatches(copy, adCopy)) {
    return null;
  }

  return { copy, adCopy, imageCopy };
};

export type CreativeCopyContractMode =
  | { kind: 'LEGACY'; copy: CreativeCopy }
  | {
      kind: 'E2';
      copy: CreativeCopy;
      adCopy: CreativeAdCopy;
      imageCopy: CreativeImageCopy;
    }
  | { kind: 'INVALID' };

export const classifyCreativeCopyContract = (
  value: Record<string, unknown>
): CreativeCopyContractMode => {
  const parsed = parseCreativeCopyContract(value);
  if (!parsed) return { kind: 'INVALID' };
  const hasAdCopy = parsed.adCopy !== undefined;
  const hasImageCopy = parsed.imageCopy !== undefined;
  if (!hasAdCopy && !hasImageCopy) return { kind: 'LEGACY', copy: parsed.copy };
  if (!hasAdCopy || !hasImageCopy) return { kind: 'INVALID' };
  return {
    kind: 'E2',
    copy: parsed.copy,
    adCopy: parsed.adCopy!,
    imageCopy: parsed.imageCopy!,
  };
};

export const resolveCreativeAdCopy = (value: {
  copy: CreativeCopy;
  adCopy?: CreativeAdCopy;
}): CreativeAdCopy => value.adCopy ?? value.copy;
