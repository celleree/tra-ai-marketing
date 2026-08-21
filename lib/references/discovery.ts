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
  'tax debt relief',
  'IRS tax debt',
  'owe the IRS',
  'back taxes help',
  'tax resolution',
  'IRS tax relief',
  'settle tax debt',
];

const DEFAULT_ACTOR_ID = 'apify~facebook-ads-scraper';
const RESULTS_PER_SEARCH = 12;
const MAX_CANDIDATES = 30;

const STRONG_TAX_RELIEF_PHRASES = [
  'tax relief',
  'tax debt',
  'irs debt',
  'back taxes',
  'tax resolution',
  'tax settlement',
  'tax forgiveness',
  'tax problems',
  'tax problem',
  'irs problems',
  'irs problem',
  'owe the irs',
  'owing the irs',
  'unpaid taxes',
  'delinquent taxes',
  'irs notice',
  'irs lien',
  'irs levy',
  'tax lien',
  'tax levy',
  'offer in compromise',
  'fresh start program',
  'tax attorney',
  'tax lawyer',
];

const TAX_DISTRESS_TERMS = [
  'debt',
  'back taxes',
  'owe',
  'owing',
  'unpaid',
  'delinquent',
  'lien',
  'levy',
  'garnishment',
  'collections',
  'penalties',
  'notice',
  'audit',
];

const TAX_RESOLUTION_TERMS = [
  'relief',
  'resolution',
  'resolve',
  'settlement',
  'settle',
  'forgiveness',
  'representation',
  'represent',
  'attorney',
  'lawyer',
  'negotiate',
  'consultation',
  'help',
  'fresh start',
  'offer in compromise',
];

const OFF_TARGET_PHRASES = [
  'property tax',
  'property taxes',
  'real estate',
  'realtor',
  'homebuyer',
  'home buyer',
  'sell your house',
  'land for sale',
  'tax preparation',
  'tax prep',
  'file your taxes',
  'tax return',
  'tax returns',
  'bookkeeping',
  'accounting services',
  'tax professional',
  'tax professionals',
  'tax practice',
  'practice owner',
  'success summit',
  'live virtual event',
  'training',
  'webinar',
  'course',
  'continuing education',
];

const asString = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    const candidate = asString(value);
    if (candidate) return candidate;
  }
  return '';
};

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const includesPhrase = (text: string, phrase: string) =>
  ` ${text} `.includes(` ${normalizeText(phrase)} `);

const includesAny = (text: string, phrases: string[]) =>
  phrases.some((phrase) => includesPhrase(text, phrase));

const buildSearchUrl = (term: string) => {
  const url = new URL('https://www.facebook.com/ads/library/');
  url.searchParams.set('active_status', 'active');
  url.searchParams.set('ad_type', 'all');
  url.searchParams.set('country', 'US');
  url.searchParams.set('media_type', 'image');
  url.searchParams.set('q', term);
  url.searchParams.set('search_type', 'keyword_exact_phrase');
  return url.toString();
};

const readText = (value: unknown) => {
  if (typeof value === 'string') return value.trim();
  const record = asRecord(value);
  if (!record) return '';
  return firstString(record.text, record.body, record.value, record.title);
};

const collectCreativeText = (item: Record<string, unknown>) => {
  const snapshot = asRecord(item.snapshot) || {};
  const pageInfo = asRecord(item.pageInfo);
  const page = asRecord(pageInfo?.page);
  const parts = [
    firstString(item.pageName, snapshot.pageName, page?.name),
    readText(snapshot.body),
    firstString(snapshot.title),
    firstString(snapshot.caption),
    firstString(snapshot.linkDescription),
    firstString(snapshot.linkUrl),
  ];

  if (Array.isArray(snapshot.cards)) {
    for (const value of snapshot.cards) {
      const card = asRecord(value);
      if (!card) continue;
      parts.push(
        readText(card.body),
        firstString(card.title),
        firstString(card.caption),
        firstString(card.linkDescription),
        firstString(card.linkUrl)
      );
    }
  }

  if (Array.isArray(snapshot.extraTexts)) {
    for (const value of snapshot.extraTexts) {
      parts.push(readText(value));
    }
  }

  return normalizeText(parts.filter(Boolean).join(' '));
};

const hasTaxReliefSignal = (item: Record<string, unknown>) => {
  const text = collectCreativeText(item);
  if (!text) return false;

  const hasTaxOrIrs =
    includesPhrase(text, 'tax') ||
    includesPhrase(text, 'taxes') ||
    includesPhrase(text, 'irs') ||
    includesPhrase(text, 'internal revenue service');
  if (!hasTaxOrIrs) return false;

  const hasStrongSignal = includesAny(text, STRONG_TAX_RELIEF_PHRASES);
  const hasDistressSignal = includesAny(text, TAX_DISTRESS_TERMS);
  const hasResolutionSignal = includesAny(text, TAX_RESOLUTION_TERMS);
  const hasIrsSignal =
    includesPhrase(text, 'irs') || includesPhrase(text, 'internal revenue service');
  const hasOffTargetSignal = includesAny(text, OFF_TARGET_PHRASES);

  // General tax-prep, accounting, real-estate/property-tax and tax-pro training
  // ads are common false positives in Meta search. Only keep one of those when
  // the ad also contains clear consumer tax-debt distress plus resolution intent.
  if (
    hasOffTargetSignal &&
    !(hasDistressSignal && (hasResolutionSignal || hasIrsSignal))
  ) {
    return false;
  }

  return (
    hasStrongSignal ||
    (hasDistressSignal && hasResolutionSignal) ||
    (hasIrsSignal && hasResolutionSignal)
  );
};

const readMediaUrl = (value: unknown) => {
  if (typeof value === 'string') return value.trim();
  const media = asRecord(value);
  if (!media) return '';

  const nestedImage = asRecord(media.image);
  return firstString(
    media.originalImageUrl,
    media.resizedImageUrl,
    media.watermarkedResizedImageUrl,
    media.original_image_url,
    media.resized_image_url,
    media.watermarked_resized_image_url,
    media.imageUrl,
    media.image_url,
    media.url,
    media.src,
    nestedImage?.originalImageUrl,
    nestedImage?.resizedImageUrl,
    nestedImage?.url
  );
};

const getImageUrls = (item: Record<string, unknown>) => {
  const snapshot = asRecord(item.snapshot) || {};
  const groups = [snapshot.images, snapshot.extraImages, snapshot.cards, item.images];
  const urls: string[] = [];

  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      const url = readMediaUrl(entry);
      if (url) urls.push(url);
    }
  }

  return [...new Set(urls)];
};

const hasVideoMedia = (item: Record<string, unknown>) => {
  const snapshot = asRecord(item.snapshot) || {};
  const videos = [snapshot.videos, snapshot.extraVideos, item.videos];
  if (videos.some((value) => Array.isArray(value) && value.length > 0)) return true;

  if (Array.isArray(snapshot.cards)) {
    for (const value of snapshot.cards) {
      const card = asRecord(value);
      if (!card) continue;
      if (
        firstString(
          card.videoHdUrl,
          card.videoSdUrl,
          card.watermarkedVideoHdUrl,
          card.watermarkedVideoSdUrl,
          card.video_hd_url,
          card.video_sd_url
        )
      ) {
        return true;
      }
    }
  }

  return false;
};

const isStaticImageAd = (item: Record<string, unknown>) => {
  if (item.isActive === false) return false;

  const snapshot = asRecord(item.snapshot) || {};
  const format = firstString(
    snapshot.displayFormat,
    item.displayFormat,
    item.display_format
  ).toUpperCase();

  if (format.includes('VIDEO') || hasVideoMedia(item)) return false;
  return getImageUrls(item).length > 0;
};

const searchTermFromInput = (item: Record<string, unknown>) => {
  const inputUrl = firstString(item.inputUrl, item.originalInputUrl, item.sourceUrl);
  if (!inputUrl) return '';

  try {
    return new URL(inputUrl).searchParams.get('q')?.trim() || '';
  } catch {
    return '';
  }
};

const normalizeItem = (value: unknown): DiscoveredCreative[] => {
  const item = asRecord(value);
  if (!item || !isStaticImageAd(item) || !hasTaxReliefSignal(item)) return [];

  const snapshot = asRecord(item.snapshot) || {};
  const pageInfo = asRecord(item.pageInfo);
  const page = asRecord(pageInfo?.page);
  const adId = firstString(
    item.adArchiveID,
    item.adArchiveId,
    item.ad_archive_id,
    item.adId,
    item.ad_id,
    item.id
  );
  const advertiser = firstString(
    item.pageName,
    snapshot.pageName,
    page?.name,
    item.advertiserName,
    item.advertiser_name,
    'Unknown advertiser'
  );
  const sourceUrl = firstString(
    item.adLibraryURL,
    item.adLibraryUrl,
    item.ad_snapshot_url,
    item.adSnapshotUrl,
    adId ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adId)}` : '',
    item.inputUrl
  );
  const startDate = firstString(
    item.startDateFormatted,
    item.ad_delivery_start_date,
    item.start_date
  );
  const searchTerm = searchTermFromInput(item);

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
  endpoint.searchParams.set('timeout', '180');
  endpoint.searchParams.set('clean', 'true');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls: searchTerms.map((term) => ({ url: buildSearchUrl(term) })),
      resultsLimit: RESULTS_PER_SEARCH,
      activeStatus: 'active',
      includeAboutPage: false,
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

  return candidates
    .filter((candidate) => {
      const key = `${candidate.adId}|${candidate.imageUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CANDIDATES);
};
