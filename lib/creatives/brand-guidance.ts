'use client';

import { parseBrandColors } from '@/lib/company/brand-colors';
import {
  brandFontLabel,
  parseBrandFontAssets,
  type BrandFontAsset,
} from '@/lib/company/brand-fonts';
import {
  TRA_BRAND_COLORS,
  TRA_CANONICAL_LOGO_URL,
} from '@/lib/company/tra-brand';

const STORAGE_KEY = 'tra-company-profile-v2';
const STORED_MEDIA_URL = /\/api\/media\/files\/(media_[a-f0-9]{32})\.(?:png|jpg|webp)(?:\?.*)?$/;

export interface StoredBrandGuidance {
  logo: { url: string; mediaId: string | null };
  colors: string[];
  fonts: BrandFontAsset[];
  fontGuidance: string[];
}

const defaultGuidance = (): StoredBrandGuidance => ({
  logo: { url: TRA_CANONICAL_LOGO_URL, mediaId: null },
  colors: [...TRA_BRAND_COLORS],
  fonts: [],
  fontGuidance: [],
});

export function readStoredBrandGuidance(): StoredBrandGuidance {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultGuidance();

    const parsed = JSON.parse(raw) as {
      brandGuidelines?: {
        logo?: unknown;
        brandColors?: unknown;
        fonts?: unknown;
      };
    };
    const logoUrl =
      typeof parsed.brandGuidelines?.logo === 'string'
        ? parsed.brandGuidelines.logo.trim()
        : '';
    const logoMatch = logoUrl ? STORED_MEDIA_URL.exec(logoUrl) : null;
    const parsedColors = parseBrandColors(
      typeof parsed.brandGuidelines?.brandColors === 'string'
        ? parsed.brandGuidelines.brandColors
        : ''
    );
    const fonts = parseBrandFontAssets(
      typeof parsed.brandGuidelines?.fonts === 'string'
        ? parsed.brandGuidelines.fonts
        : ''
    );

    return {
      logo: logoMatch
        ? { url: logoUrl, mediaId: logoMatch[1] }
        : { url: TRA_CANONICAL_LOGO_URL, mediaId: null },
      colors: parsedColors.length ? parsedColors : [...TRA_BRAND_COLORS],
      fonts,
      fontGuidance: fonts.map((font) => {
        const name = brandFontLabel(font);
        return font.styleDescription
          ? `${name}: ${font.styleDescription}`
          : `${name}: approved uploaded brand font`;
      }),
    };
  } catch {
    return defaultGuidance();
  }
}
