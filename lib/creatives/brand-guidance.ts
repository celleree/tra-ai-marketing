'use client';

import { parseBrandColors } from '@/lib/company/brand-colors';
import {
  brandFontLabel,
  parseBrandFontAssets,
  type BrandFontAsset,
} from '@/lib/company/brand-fonts';

const STORAGE_KEY = 'tra-company-profile-v2';
const STORED_MEDIA_URL = /\/api\/media\/files\/(media_[a-f0-9]{32})\.(?:png|jpg|webp)(?:\?.*)?$/;

export interface StoredBrandGuidance {
  logo: { url: string; mediaId: string } | null;
  colors: string[];
  fonts: BrandFontAsset[];
  fontNames: string[];
  fontSpecimenMediaIds: string[];
}

export function readStoredBrandGuidance(): StoredBrandGuidance {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { logo: null, colors: [], fonts: [], fontNames: [], fontSpecimenMediaIds: [] };
    }

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
      fontNames: fonts.map(brandFontLabel),
      fontSpecimenMediaIds: fonts
        .map((font) => font.specimenMediaId)
        .filter((value): value is string => Boolean(value)),
    };
  } catch {
    return { logo: null, colors: [], fonts: [], fontNames: [], fontSpecimenMediaIds: [] };
  }
}
