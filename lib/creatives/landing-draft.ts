import type { CreativeSourceAsset } from '@/lib/media/types';
import { parseCreativeSourceAsset } from '@/lib/media/source-contract';
import { MAX_PORTFOLIO_CREATIVES } from '@/lib/creatives/planned';

const STORAGE_KEY = 'tra-ai-marketing:landing-creative-draft';
const SCHEMA_VERSION = 2;
const MIN_VARIATIONS = 2;
const MAX_VARIATIONS = MAX_PORTFOLIO_CREATIVES;

export interface LandingCreativeDraft {
  version: typeof SCHEMA_VERSION;
  context: string;
  sourceAsset: CreativeSourceAsset | null;
  variationCount: number;
  generateOnOpen: boolean;
}

export function storeLandingCreativeDraft(draft: LandingCreativeDraft) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

export function consumeLandingCreativeDraft(): LandingCreativeDraft | null {
  if (typeof window === 'undefined') return null;

  const rawDraft = window.sessionStorage.getItem(STORAGE_KEY);
  if (!rawDraft) return null;
  window.sessionStorage.removeItem(STORAGE_KEY);

  try {
    const parsed = JSON.parse(rawDraft) as Record<string, unknown>;
    if (
      parsed.version !== SCHEMA_VERSION ||
      typeof parsed.context !== 'string' ||
      !parsed.context.trim()
    ) {
      return null;
    }

    const source = parsed.sourceAsset
      ? parseCreativeSourceAsset(parsed.sourceAsset)
      : null;
    if (source && !source.success) return null;

    const variationCount = Number(parsed.variationCount);
    return {
      version: SCHEMA_VERSION,
      context: parsed.context,
      sourceAsset: source?.success ? source.data : null,
      variationCount: Number.isFinite(variationCount)
        ? Math.min(MAX_VARIATIONS, Math.max(MIN_VARIATIONS, variationCount))
        : 4,
      generateOnOpen: parsed.generateOnOpen !== false,
    };
  } catch {
    return null;
  }
}
