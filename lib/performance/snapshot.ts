/** Shape validation only: declared provenance is not proof of live reconciliation. */
export type PerformanceSnapshot = {
  version: 1;
  source: { kind: 'imported' | 'fixture' | 'live'; reference: string; observedAt: string };
  window: { start: string; end: string; timezone: string };
  currency: string;
  adId: string;
  creativeId: string | null;
  observed: {
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    verifiedAttributableRevenue: number | null;
  };
  revenueAttribution: {
    sourceReference: string;
    attributionReference: string;
    measure: 'gross' | 'net';
  } | null;
};

export type PerformanceDerivedMetrics = {
  clickThroughRate: number | null;
  costPerClick: number | null;
  revenueOnAdSpend: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const shape = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
  isRecord(value) && required.every(key => key in value)
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
};
const currencies = new Set(Intl.supportedValuesOf('currency'));
const timezone = (value: unknown): value is string => {
  if (!text(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
};
const metric = (value: unknown, integer: boolean, allowNegative = false) =>
  value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value)
    && (allowNegative || value >= 0) && (!integer || Number.isSafeInteger(value)));

/** Missing metrics become explicit unknowns; numeric strings are not silently coerced. */
export function parsePerformanceSnapshot(value: unknown): PerformanceSnapshot | null {
  if (!shape(value, ['version', 'source', 'window', 'currency', 'adId', 'observed'], ['creativeId', 'revenueAttribution'])
    || value.version !== 1 || !shape(value.source, ['kind', 'reference', 'observedAt'])
    || !['imported', 'fixture', 'live'].includes(String(value.source.kind))
    || !text(value.source.reference) || !timestamp(value.source.observedAt)
    || !shape(value.window, ['start', 'end', 'timezone']) || !timestamp(value.window.start)
    || !timestamp(value.window.end) || Date.parse(value.window.start) >= Date.parse(value.window.end)
    || Date.parse(value.window.end) > Date.parse(value.source.observedAt) || !timezone(value.window.timezone)
    || typeof value.currency !== 'string' || !currencies.has(value.currency)
    || typeof value.adId !== 'string' || !/^\d{1,40}$/.test(value.adId)
    || (value.creativeId != null && (typeof value.creativeId !== 'string' || !/^creative_[a-f0-9]{32}$/.test(value.creativeId)))
    || !shape(value.observed, [], ['spend', 'impressions', 'clicks', 'verifiedAttributableRevenue'])) return null;

  const revenue = value.observed.verifiedAttributableRevenue;
  const attribution = value.revenueAttribution;
  if (attribution != null && (!shape(attribution, ['sourceReference', 'attributionReference', 'measure'])
    || !text(attribution.sourceReference) || !text(attribution.attributionReference)
    || (attribution.measure !== 'gross' && attribution.measure !== 'net'))) return null;
  if (revenue != null && attribution == null) return null;
  if (!metric(value.observed.spend, false) || !metric(value.observed.impressions, true)
    || !metric(value.observed.clicks, true) || !metric(revenue, false, isRecord(attribution) && attribution.measure === 'net')) return null;

  return {
    version: 1,
    source: { ...value.source } as PerformanceSnapshot['source'],
    window: { ...value.window } as PerformanceSnapshot['window'],
    currency: value.currency, adId: value.adId, creativeId: (value.creativeId ?? null) as string | null,
    observed: {
      spend: (value.observed.spend ?? null) as number | null,
      impressions: (value.observed.impressions ?? null) as number | null,
      clicks: (value.observed.clicks ?? null) as number | null,
      verifiedAttributableRevenue: (revenue ?? null) as number | null,
    },
    revenueAttribution: attribution == null ? null : { ...attribution } as PerformanceSnapshot['revenueAttribution'],
  };
}

/** Diagnostic ratios only; these values do not establish winners or eligibility. */
export function derivePerformanceMetrics(snapshot: PerformanceSnapshot): PerformanceDerivedMetrics {
  const { spend, clicks, impressions, verifiedAttributableRevenue: revenue } = snapshot.observed;
  const ratio = (numerator: number | null, denominator: number | null) => {
    if (numerator === null || denominator === null || denominator <= 0) return null;
    const result = numerator / denominator;
    return Number.isFinite(result) ? result : null;
  };
  return { clickThroughRate: ratio(clicks, impressions), costPerClick: ratio(spend, clicks),
    revenueOnAdSpend: ratio(revenue, spend) };
}
