import { describe, expect, it } from 'vitest';
import { allowedImageUrl, extractCandidates, parseSearch, rankCandidates, sampleRows } from '@/lib/discovery/model';
const extract = (rows: unknown = sampleRows) => extractCandidates(rows, 'run1', 'sample', '2026-10-15T00:00:00.000Z');
describe('discovery extraction and ranking', () => {
  it('defaults to ten, rejects fractional/out-of-range counts and bounds input', () => {
    expect(parseSearch({ query: 'consultation' }).limit).toBe(10);
    for (const limit of [0, 101, 2.5, '10', null]) expect(() => parseSearch({ query: 'tax', limit })).toThrow();
    expect(() => parseSearch({ query: '' })).toThrow();
    expect(parseSearch({ query: 'tax', limit: 100 }).limit).toBe(100);
  });
  it('keeps cross-industry results while preferring tax, with unknown performance and visual signals', () => {
    const ranked = rankCandidates(extract(), parseSearch({ query: 'consultation' }));
    expect(ranked.candidates).toHaveLength(3);
    expect(ranked.candidates[0].advertiser).toContain('tax');
    expect(ranked.candidates.every(item => item.performance === 'unknown' && item.inference.humanPresence === 'unknown')).toBe(true);
    expect(extract()[1].status).toBe('unknown');
    expect(extract()[0].startDate).toBeNull();
  });
  it('deduplicates image URLs independent of signed query and preserves source links', () => {
    const items = extract(); const duplicate = { ...items[0], id: 'copy', adId: '444', sourceUrl: 'https://www.facebook.com/ads/library/?id=444', imageUrl: `${items[0].imageUrl}?signature=changed` };
    const ranked = rankCandidates([...items, duplicate], parseSearch({ query: 'consultation' }));
    expect(ranked.exactDuplicates).toBe(1);
    expect(ranked.candidates.find(item => item.adId === '10001')?.duplicateSources?.[0].adId).toBe('444');
  });
  it('flags near-copy variants honestly and diversifies advertisers', () => {
    const [first, second] = extract();
    const variant = { ...first, id: 'variant', imageUrl: 'https://scontent.xx.fbcdn.net/variant.jpg', text: `${first.text} Today` };
    const result = rankCandidates([first, variant, second], parseSearch({ query: 'free consultation', preferTax: false }));
    expect(result.candidates.some(item => item.nearDuplicateOf)).toBe(true);
    expect(result.candidates[1].advertiser).toBe(second.advertiser);
  });
  it('accepts only observed HTTPS CDN image hosts and ignores malformed/video entries', () => {
    for (const url of ['http://scontent.xx.fbcdn.net/a.jpg', 'https://fbcdn.net.evil.test/a.jpg', 'https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://u:p@scontent.xx.fbcdn.net/a.jpg', 'https://scontent.xx.fbcdn.net:444/a.jpg']) expect(() => allowedImageUrl(url)).toThrow();
    expect(extract([{}, { ...sampleRows[0], adArchiveID: 'not-an-ad' }])).toEqual([]);
    expect(() => extract({ items: [] })).toThrow('array');
  });
});
