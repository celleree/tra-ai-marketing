import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredBrandGuidance } from '@/lib/creatives/brand-guidance';
afterEach(() => vi.unstubAllGlobals());
const profile = (value: string | null) => vi.stubGlobal('window', { localStorage: { getItem: () => value } });
describe('configured uploaded logo admission', () => {
  it('omits even a configured logo only when the caller explicitly chooses omission, retaining colors/fonts', () => {
    profile(JSON.stringify({ brandGuidelines: { logo: 'unavailable-logo.png', brandColors: '#0577BF' } }));
    expect(readStoredBrandGuidance({ omitLogo: true })).toMatchObject({ logo: null, colors: ['#0577BF'] });
    expect(() => readStoredBrandGuidance()).toThrow('saved TRA logo');
  });
  it('passes the original canonical logo ID to server compositing', () => {
    const id = `media_${'a'.repeat(32)}`, url = `/api/media/files/${id}.png`;
    profile(JSON.stringify({ brandGuidelines: { logo: url } }));
    expect(readStoredBrandGuidance().logo).toEqual({ url, mediaId: id });
  });
  it('blocks an unusable configured logo rather than silently sending an unbranded request', () => {
    profile(JSON.stringify({ brandGuidelines: { logo: 'stale-logo.png' } }));
    expect(() => readStoredBrandGuidance()).toThrow('saved TRA logo');
    profile(JSON.stringify({ brandGuidelines: { logo: { url: 'legacy-value' } } }));
    expect(() => readStoredBrandGuidance()).toThrow('saved TRA logo');
  });
  it('blocks unreadable saved settings and leaves an intentional no-logo profile allowed', () => {
    profile('{broken'); expect(() => readStoredBrandGuidance()).toThrow('brand settings could not be read');
    profile(null); expect(readStoredBrandGuidance().logo).toBeNull();
    profile(JSON.stringify({ brandGuidelines: { logo: '' } })); expect(readStoredBrandGuidance().logo).toBeNull();
  });
});
