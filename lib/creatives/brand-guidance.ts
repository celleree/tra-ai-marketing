'use client';

import { parseBrandColors } from '@/lib/company/brand-colors';
import {
  brandFontLabel,
  parseBrandFontAssets,
  type BrandFontAsset,
} from '@/lib/company/brand-fonts';

const STORAGE_KEY = 'tax-marketing-studio:company-profile:v1';
const STORED_MEDIA_URL = /\/api\/media\/files\/(media_[a-f0-9]{32})\.(?:png|jpg|webp)(?:\?.*)?$/;

export interface StoredBrandGuidance {
  logo: { url: string; mediaId: string } | null;
  colors: string[];
  fonts: BrandFontAsset[];
  fontGuidance: string[];
}

const emptyGuidance = (): StoredBrandGuidance => ({
  logo: null,
  colors: [],
  fonts: [],
  fontGuidance: [],
});

export function readStoredBrandGuidance({ omitLogo = false }: { omitLogo?: boolean } = {}): StoredBrandGuidance {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyGuidance();

    const parsed = JSON.parse(raw) as {
      brandGuidelines?: {
        logo?: unknown;
        brandColors?: unknown;
        fonts?: unknown;
      };
    };
    const logoUrl =
      !omitLogo && typeof parsed.brandGuidelines?.logo === 'string'
        ? parsed.brandGuidelines.logo.trim()
        : '';
    if (!omitLogo && parsed.brandGuidelines?.logo != null && typeof parsed.brandGuidelines.logo !== 'string') {
      throw new Error('The saved Company logo is not a usable uploaded asset. Save the logo in Company > Brand Guidelines before generating.');
    }
    const logoMatch = logoUrl ? STORED_MEDIA_URL.exec(logoUrl) : null;
    if (logoUrl && !logoMatch) throw new Error('The saved Company logo is not a usable uploaded asset. Save the logo in Company > Brand Guidelines before generating.');
    const colors = parseBrandColors(
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
      logo: logoMatch ? { url: logoUrl, mediaId: logoMatch[1] } : null,
      colors,
      fonts,
      fontGuidance: fonts.map((font) => {
        const name = brandFontLabel(font);
        return font.styleDescription
          ? `${name}: ${font.styleDescription}`
          : `${name}: approved uploaded brand font`;
      }),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The saved Company logo')) throw error;
    throw new Error('Saved Company brand settings could not be read. Open Company and save them before generating.');
  }
}
