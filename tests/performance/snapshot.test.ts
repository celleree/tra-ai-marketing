import { describe, expect, it } from 'vitest';
import { derivePerformanceMetrics, parsePerformanceSnapshot } from '@/lib/performance/snapshot';

const snapshot = () => ({
  version: 1,
  source: { kind: 'imported', reference: 'approved-export.csv:row-2', observedAt: '2026-10-11T12:00:00Z' },
  window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z', timezone: 'America/Los_Angeles' },
  currency: 'USD', adId: '12345', creativeId: `creative_${'a'.repeat(32)}`,
  observed: { spend: 100, impressions: 1000, clicks: 20, verifiedAttributableRevenue: 200 },
  revenueAttribution: { sourceReference: 'TRA-approved-export:row-5', attributionReference: 'approved-join:12345', measure: 'gross' },
});

describe('offline performance snapshot contract', () => {
  it.each(['fixture', 'imported', 'live'])('preserves declared %s provenance without claiming reconciliation', kind => {
    const input = snapshot(); input.source.kind = kind;
    expect(parsePerformanceSnapshot(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });
  it('retains omitted revenue and creative mapping as unknown, separately from derived diagnostics', () => {
    const input = snapshot();
    const parsed = parsePerformanceSnapshot({ ...input, creativeId: undefined, observed: { spend: 100, clicks: 0 }, revenueAttribution: null });
    expect(parsed?.observed).toEqual({ spend: 100, clicks: 0, impressions: null, verifiedAttributableRevenue: null });
    expect(parsed?.creativeId).toBeNull();
    expect(derivePerformanceMetrics(parsed!)).toEqual({ clickThroughRate: null, costPerClick: null, revenueOnAdSpend: null });
  });
  it('keeps explicit zero revenue as measured and derives ratios without modifying observations', () => {
    const input = snapshot(); input.observed.verifiedAttributableRevenue = 0;
    const parsed = parsePerformanceSnapshot(input)!;
    expect(derivePerformanceMetrics(parsed)).toEqual({ clickThroughRate: 0.02, costPerClick: 5, revenueOnAdSpend: 0 });
    expect(parsed.observed).toEqual(input.observed);
  });
  it('accepts explicitly net refund-adjusted revenue, but rejects negative gross revenue', () => {
    const input = snapshot(); input.observed.verifiedAttributableRevenue = -20;
    expect(parsePerformanceSnapshot(input)).toBeNull();
    input.revenueAttribution.measure = 'net';
    expect(parsePerformanceSnapshot(input)?.observed.verifiedAttributableRevenue).toBe(-20);
  });
  it.each([
    ['unknown source', (v: ReturnType<typeof snapshot>) => ({ ...v, source: { ...v.source, kind: 'predicted' } })],
    ['missing source identity', (v: ReturnType<typeof snapshot>) => ({ ...v, source: { ...v.source, reference: '' } })],
    ['invalid currency', (v: ReturnType<typeof snapshot>) => ({ ...v, currency: 'ZZZ' })],
    ['reversed window', (v: ReturnType<typeof snapshot>) => ({ ...v, window: { ...v.window, end: v.window.start } })],
    ['invalid date', (v: ReturnType<typeof snapshot>) => ({ ...v, window: { ...v.window, start: '2026-02-30T00:00:00Z' } })],
    ['future observation window', (v: ReturnType<typeof snapshot>) => ({ ...v, source: { ...v.source, observedAt: v.window.start } })],
    ['invalid timezone', (v: ReturnType<typeof snapshot>) => ({ ...v, window: { ...v.window, timezone: 'Invalid/Zone' } })],
    ['missing ad identity', (v: ReturnType<typeof snapshot>) => ({ ...v, adId: '' })],
    ['invalid creative identity', (v: ReturnType<typeof snapshot>) => ({ ...v, creativeId: 'missing-join' })],
    ['missing revenue evidence', (v: ReturnType<typeof snapshot>) => ({ ...v, revenueAttribution: null })],
    ['missing attribution reference', (v: ReturnType<typeof snapshot>) => ({ ...v, revenueAttribution: { ...v.revenueAttribution, attributionReference: '' } })],
    ['negative spend', (v: ReturnType<typeof snapshot>) => ({ ...v, observed: { ...v.observed, spend: -1 } })],
    ['negative clicks', (v: ReturnType<typeof snapshot>) => ({ ...v, observed: { ...v.observed, clicks: -1 } })],
    ['fractional counts', (v: ReturnType<typeof snapshot>) => ({ ...v, observed: { ...v.observed, impressions: 1.5 } })],
    ['export numeric string', (v: ReturnType<typeof snapshot>) => ({ ...v, observed: { ...v.observed, spend: '100' } })],
    ['nonfinite value', (v: ReturnType<typeof snapshot>) => ({ ...v, observed: { ...v.observed, spend: Infinity } })],
    ['derived input masquerading as observation', (v: ReturnType<typeof snapshot>) => ({ ...v, observed: { ...v.observed, roas: 2 } })],
  ])('rejects %s', (_label, mutate) => expect(parsePerformanceSnapshot(mutate(snapshot()))).toBeNull());
  it('does not accept batch arrays or silently deduplicate observations', () => {
    expect(parsePerformanceSnapshot([snapshot(), snapshot()])).toBeNull();
  });
  it('compares timestamp instants across supported precision and preserves explicit unknown metrics', () => {
    const input = snapshot();
    expect(parsePerformanceSnapshot({ ...input, window: { ...input.window, start: input.window.end.replace('Z', '.000Z') } })).toBeNull();
    const parsed = parsePerformanceSnapshot({ ...input, observed: { spend: null, impressions: null, clicks: null, verifiedAttributableRevenue: null } });
    expect(parsed?.observed).toEqual({ spend: null, impressions: null, clicks: null, verifiedAttributableRevenue: null });
    expect(derivePerformanceMetrics(parsed!)).toEqual({ clickThroughRate: null, costPerClick: null, revenueOnAdSpend: null });
  });
});
