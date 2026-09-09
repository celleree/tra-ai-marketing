import { describe, expect, it, vi } from 'vitest';
import {
  completeProgressiveCreative,
  insertCreativeByIndex,
} from '@/lib/creatives/progressive-delivery';
import type { GeneratedCreative } from '@/lib/creatives/generated';

const creative = (index: number): GeneratedCreative => ({
  id: `creative_${index}`,
  index,
  category: 'customer-problems',
  format: 'direct-response',
  image: {
    id: `media_${String(index).repeat(32)}`,
    fileName: `media_${String(index).repeat(32)}.png`,
    originalName: 'creative.png',
    mimeType: 'image/png',
    size: 12,
    url: `/api/media/files/media_${String(index).repeat(32)}.png`,
  },
  copy: { headline: 'Headline', primaryText: 'Primary', description: 'Description' },
});

describe('progressive client completion', () => {
  it('skips browser branding and duplicate persistence for server-saved creatives', async () => {
    const saved = { ...creative(1), finalization: { status: 'SAVED' as const, createdAt: '2026-09-07T20:00:00.000Z' } };
    const applyBrandLogo = vi.fn();
    const persist = vi.fn();
    await expect(completeProgressiveCreative({ creative: saved, logoUrl: '/logo.png', applyBrandLogo, persist })).resolves.toBe(saved);
    expect(applyBrandLogo).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
  it('persists only the branded creative and returns it for display', async () => {
    const generated = creative(2);
    const branded = { ...generated, image: { ...generated.image, id: `media_${'b'.repeat(32)}` } };
    const applyBrandLogo = vi.fn(async () => [branded]);
    const persist = vi.fn(async () => undefined);

    await expect(
      completeProgressiveCreative({
        creative: generated,
        logoUrl: '/api/media/files/logo.png',
        applyBrandLogo,
        persist,
      })
    ).resolves.toEqual(branded);
    expect(persist).toHaveBeenCalledWith(branded);
  });

  it('does not persist an unbranded creative when logo compositing fails, then allows later completion', async () => {
    const persist = vi.fn(async () => undefined);
    await expect(
      completeProgressiveCreative({
        creative: creative(1),
        logoUrl: '/api/media/files/logo.png',
        applyBrandLogo: async () => [],
        persist,
      })
    ).rejects.toThrow('branded creative');
    expect(persist).not.toHaveBeenCalled();

    await expect(
      completeProgressiveCreative({
        creative: creative(2),
        applyBrandLogo: async (items) => items,
        persist,
      })
    ).resolves.toMatchObject({ index: 2 });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('keeps completed creatives in original index order regardless of delivery order', () => {
    expect(insertCreativeByIndex([creative(3)], creative(1)).map((item) => item.index)).toEqual([
      1,
      3,
    ]);
  });
});
