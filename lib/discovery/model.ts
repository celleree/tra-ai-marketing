import { DiscoveryError } from './errors';
import { createHash } from 'node:crypto';
export type Search = { query: string; limit: number; preferTax: boolean };
export type Candidate = {
  id: string; adId: string; advertiser: string; sourceUrl: string; imageUrl: string; text: string;
  startDate: string | null; endDate: string | null; status: 'active' | 'inactive' | 'unknown';
  observedAt: string; provider: 'apify/facebook-ads-scraper' | 'sample'; runId: string;
  reasons: string[]; score: number; nearDuplicateOf?: string;
  duplicateSources?: { adId: string; sourceUrl: string }[];
  inference: { angle: string; offer: string; layout: 'unknown'; humanPresence: 'unknown' }; performance: 'unknown';
};
export function parseSearch(value: Record<string, unknown>): Search {
  const query = typeof value.query === 'string' ? value.query.trim() : '';
  const limit = value.limit === undefined ? 10 : value.limit;
  if (!query || query.length > 160 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new DiscoveryError('Enter a search up to 160 characters and a result count from 1 to 100.');
  return { query, limit: Number(limit), preferTax: value.preferTax !== false };
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === 'string' ? value.slice(0, 6000).trim() : '';
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const date = (value: unknown) => string(value) && Number.isFinite(Date.parse(string(value))) ? new Date(string(value)).toISOString() : null;
export function allowedImageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)fbcdn\.net$/.test(url.hostname)) throw new DiscoveryError('Unsupported media host. Upload the image manually instead.');
  return url;
}
export function extractCandidates(rows: unknown, runId: string, provider: Candidate['provider'], observedAt: string): Candidate[] {
  if (!Array.isArray(rows)) throw new DiscoveryError('Provider dataset must be an array.');
  return rows.slice(0, 100).flatMap(value => {
    const row = record(value), snapshot = record(row.snapshot), adId = string(row.adArchiveID || row.adArchiveId);
    if (!/^\d{1,40}$/.test(adId)) return [];
    const text = [string(record(snapshot.body).text), string(snapshot.title), string(snapshot.linkDescription)].filter(Boolean).join(' ');
    const images = Array.isArray(snapshot.images) ? snapshot.images : [], cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    return [...images, ...cards].slice(0, 10).flatMap((entry, index) => {
      const media = record(entry), imageUrl = string(media.originalImageUrl || media.resizedImageUrl);
      try { allowedImageUrl(imageUrl); } catch { return []; }
      if (media.videoHdUrl || media.videoSdUrl) return [];
      return [{ id: createHash('sha256').update(`${runId}|${adId}|${index}|${imageUrl}`).digest('hex').slice(0, 32), adId,
        advertiser: string(row.pageName || snapshot.pageName) || 'Unknown advertiser', sourceUrl: `https://www.facebook.com/ads/library/?id=${adId}`, imageUrl,
        text: [text, string(media.body), string(media.title)].filter(Boolean).join(' ').slice(0, 6000),
        startDate: date(row.startDateFormatted), endDate: date(row.endDateFormatted), status: row.isActive === true ? 'active' as const : row.isActive === false ? 'inactive' as const : 'unknown' as const,
        observedAt, provider, runId, score: 0, reasons: [], inference: { angle: 'unknown', offer: 'unknown', layout: 'unknown' as const, humanPresence: 'unknown' as const }, performance: 'unknown' as const }];
    });
  });
}
export function rankCandidates(candidates: Candidate[], search: Search) {
  const exact = new Map<string, Candidate>(); let exactDuplicates = 0;
  const unique = candidates.filter(candidate => {
    const url = new URL(candidate.imageUrl), key = url.origin + url.pathname;
    const prior = exact.get(key);
    if (prior) { exactDuplicates++; prior.duplicateSources = [...(prior.duplicateSources ?? []), { adId: candidate.adId, sourceUrl: candidate.sourceUrl }]; return false; } exact.set(key, candidate); return true;
  }).map(candidate => {
    const tokens = words(candidate.text), matches = [...words(search.query)].filter(word => tokens.has(word));
    const tax = /\b(tax debt|tax relief|irs|back taxes)\b/i.test(candidate.text);
    return { ...candidate, score: matches.length * 3 + (search.preferTax && tax ? 2 : 0),
      reasons: [...(matches.length ? [`Copy matches: ${matches.join(', ')}`] : ['Cross-industry exploration; no copy match']), ...(search.preferTax && tax ? ['Tax context preference'] : [])],
      inference: { ...candidate.inference, offer: /\b(free|consultation|trial|discount|save)\b/i.exec(candidate.text)?.[0] ?? 'unknown', angle: /\b(debt|stress|pain|problem)\b/i.test(candidate.text) ? 'problem-led copy' : 'unknown' } };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  for (let i = 0; i < unique.length; i++) {
    const tokens = words(unique[i].text); if (tokens.size < 6) continue;
    const similar = unique.slice(0, i).find(prior => { const other = words(prior.text); return [...tokens].filter(token => other.has(token)).length / new Set([...tokens, ...other]).size >= 0.8; });
    if (similar) { unique[i].nearDuplicateOf = similar.id; unique[i].reasons.push('Similar copy; possible variant (visual similarity unknown)'); }
  }
  const output: Candidate[] = [], counts = new Map<string, number>();
  const adjusted = (candidate: Candidate) => candidate.score - (counts.get(candidate.advertiser) ?? 0) * 4 - (candidate.nearDuplicateOf ? 3 : 0);
  while (unique.length && output.length < search.limit) {
    unique.sort((a, b) => adjusted(b) - adjusted(a) || a.id.localeCompare(b.id)); const next = unique.shift()!;
    if (!counts.has(next.advertiser)) next.reasons.push('Advertiser diversity'); counts.set(next.advertiser, (counts.get(next.advertiser) ?? 0) + 1); output.push(next);
  }
  return { candidates: output, exactDuplicates };
}
export const sampleRows = [
  { adArchiveID: '10001', pageName: 'Sample tax service (fictional)', isActive: true, snapshot: { body: { text: 'Tax debt causing stress? Free consultation to explore your options.' }, images: [{ originalImageUrl: 'https://scontent.xx.fbcdn.net/sample-tax.jpg' }] } },
  { adArchiveID: '10002', pageName: 'Sample fitness service (fictional)', snapshot: { body: { text: 'Build a routine that fits your life. Try a free coaching consultation.' }, images: [{ originalImageUrl: 'https://scontent.xx.fbcdn.net/sample-fitness.jpg' }] } },
  { adArchiveID: '10003', pageName: 'Sample home service (fictional)', isActive: false, snapshot: { body: { text: 'Solve your repair problem with a simple checklist. Book a consultation.' }, images: [{ originalImageUrl: 'https://scontent.xx.fbcdn.net/sample-home.jpg' }] } },
];
