import { afterEach, expect, it, vi } from 'vitest';
import { consumeLandingCreativeDraft, pauseLandingCreativeDraft, storeLandingCreativeDraft } from '@/lib/creatives/landing-draft';
const key = 'tra-ai-marketing:landing-creative-draft';
afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { sessionStorage: { getItem: (id: string) => values.get(id) ?? null, setItem: (id: string, value: string) => values.set(id, value), removeItem: (id: string) => values.delete(id) } });
  return values;
}
const draft = { version: 2 as const, context: 'Retain this idea', sourceAsset: null, variationCount: 4, generateOnOpen: true };
it('keeps a bypassed draft as manual input through repeated workspace entry and reload', () => {
  storage(); storeLandingCreativeDraft(draft); pauseLandingCreativeDraft(); pauseLandingCreativeDraft();
  expect(consumeLandingCreativeDraft()).toEqual({ ...draft, generateOnOpen: false }); expect(consumeLandingCreativeDraft()).toBeNull();
});
it('retains the deliberate direct-to-Create handoff behavior', () => {
  storage(); storeLandingCreativeDraft(draft); expect(consumeLandingCreativeDraft()).toEqual(draft);
});
it('discards invalid stored drafts without creating an executable handoff', () => {
  const values = storage(); values.set(key, '{broken'); pauseLandingCreativeDraft(); expect(values.has(key)).toBe(false);
});
