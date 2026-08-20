export const MAX_BRAND_FONT_BYTES = 4 * 1024 * 1024;
export const MAX_BRAND_FONTS = 6;

export type BrandFontMimeType =
  | 'font/woff2'
  | 'font/woff'
  | 'font/ttf'
  | 'font/otf';

export interface BrandFontAsset {
  id: string;
  fileName: string;
  originalName: string;
  mimeType: BrandFontMimeType;
  size: number;
  url: string;
  specimenMediaId?: string;
  specimenUrl?: string;
  styleDescription?: string;
}

const MIME_BY_EXTENSION: Record<string, BrandFontMimeType> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

export const getBrandFontExtension = (fileName: string) => {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match?.[1]?.toLowerCase() || '';
};

export const getBrandFontMimeType = (fileName: string) =>
  MIME_BY_EXTENSION[getBrandFontExtension(fileName)] || null;

export const isSafeBrandFontFileName = (fileName: string) =>
  /^font_[a-f0-9]{32}\.(?:woff2|woff|ttf|otf)$/.test(fileName);

export const parseBrandFontAssets = (value: string): BrandFontAsset[] => {
  if (!value.trim()) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object')
      )
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        fileName: typeof item.fileName === 'string' ? item.fileName : '',
        originalName:
          typeof item.originalName === 'string' ? item.originalName : 'Brand font',
        mimeType:
          typeof item.mimeType === 'string'
            ? (item.mimeType as BrandFontMimeType)
            : ('font/woff2' as const),
        size: typeof item.size === 'number' ? item.size : Number(item.size),
        url: typeof item.url === 'string' ? item.url : '',
        specimenMediaId:
          typeof item.specimenMediaId === 'string' ? item.specimenMediaId : undefined,
        specimenUrl:
          typeof item.specimenUrl === 'string' ? item.specimenUrl : undefined,
        styleDescription:
          typeof item.styleDescription === 'string'
            ? item.styleDescription.slice(0, 500)
            : undefined,
      }))
      .filter(
        (item) =>
          /^font_[a-f0-9]{32}$/.test(item.id) &&
          isSafeBrandFontFileName(item.fileName) &&
          Boolean(item.url) &&
          Number.isFinite(item.size)
      )
      .slice(0, MAX_BRAND_FONTS);
  } catch {
    return [];
  }
};

export const serializeBrandFontAssets = (assets: BrandFontAsset[]) =>
  JSON.stringify(assets.slice(0, MAX_BRAND_FONTS));

export const brandFontLabel = (asset: BrandFontAsset) =>
  asset.originalName.replace(/\.(?:woff2|woff|ttf|otf)$/i, '').replace(/[-_]+/g, ' ');
