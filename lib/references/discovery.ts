export interface DiscoveredCreative {
  provider: 'apify-meta-ad-library';
  adId: string;
  advertiser: string;
  imageUrl: string;
  sourceUrl: string;
  startDate?: string;
  searchTerm?: string;
}

const DEFAULT_SEARCH_TERMS = [
  'tax relief',
  'tax debt',
  'IRS debt',
  'back taxes',
  'tax resolution',
];

const DEFAULT_ACTOR_ID = 'bovi~meta-ads-library-scraper';
const MAX_CANDIDATES = 30;

const asString = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    const candidate = asString(value);
    if (candidate) return candidate;
  }
  return '';
};

const getImageUrls = (item: Record<string, unknown>) => {
  const raw = Array.isArray(item.snapshot_images) ? item.snapshot_images : [];
  const urls: string[] = [];

  for (const entry of raw) {
    if (typeof entry === 'string') {
      urls.push(entry);
      continue;
    }

    if (entry && typeof entry === 'object') {
      const image = entry as Record<string, unknown>;
      const url = firstString(
        image.original_image_url,
        image.image_url,
        image.url,
        image.src
      );
      if (url) urls.push(url);
    }
  }

  return urls;
};

const isStaticImageAd = (item: Record<string, unknown>) => {
  const videos = Array.isArray(item.snapshot_videos) ? item.snapshot_videos : [];
  if (videos.length) return false;

  const format = asString(item.display_format).toUpperCase();
  if (format.includes('VIDEO')) return false;

  return getImageUrls(item).length > 0;
};

const normalizeItem = (
  value: unknown,
  fallbackSearchTerm = ''
): DiscoveredCreative[] => {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (!isStaticImageAd(item)) return [];

  const adId = firstString(item.ad_archive_id, item.ad_id, item.id);
  const advertiser = firstString(item.page_name, item.advertiser_name, 'Unknown advertiser');
  const sourceUrl = firstString(
    item.ad_snapshot_url,
    item.ad_library_url,
    item.url,
    adId ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adId)}` : ''
  );
  const startDate = firstString(item.ad_delivery_start_date, item.start_date);
  const searchTerm = firstString(item.search_term, item.searchTerm, fallbackSearchTerm);

  return getImageUrls(item).map((imageUrl) => ({
    provider: 'apify-meta-ad-library' as const,
    adId: adId || imageUrl,
    advertiser,
    imageUrl,
    sourceUrl,
    startDate: startDate || undefined,
    searchTerm: searchTerm || undefined,
  }));
};

export const findWinningCreativeCandidates = async (): Promise<DiscoveredCreative[]> => {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'Winning Creative Finder is ready, but APIFY_TOKEN is not configured.'
    );
  }

  const actorId = process.env.APIFY_META_ADS_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID;
  const configuredTerms = process.env.WINNING_CREATIVE_SEARCH_TERMS
    ?.split(',')
    .map((term) => term.trim())
    .filter(Boolean);
  const searchTerms = configuredTerms?.length ? configuredTerms : DEFAULT_SEARCH_TERMS;

  const endpoint = new URL(
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`
  );
  endpoint.searchParams.set('token', token);
  endpoint.searchParams.set('timeout', '120');
  endpoint.searchParams.set('clean', 'true');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchTerms,
      countries: ['US'],
      adType: 'all',
      activeStatus: 'active',
      maxResults: 12,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Ad discovery provider returned ${response.status}${detail ? `: ${detail}` : ''}`
    );
  }

  const raw = (await response.json()) as unknown;
  const rows = Array.isArray(raw) ? raw : [];
  const candidates = rows.flatMap((row) => normalizeItem(row));
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${candidate.adId}|${candidate.imageUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_CANDIDATES);
};
