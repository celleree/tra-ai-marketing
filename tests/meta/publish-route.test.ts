import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/meta/publish/route';
import { listCreatives } from '@/lib/creatives/storage';
import { recordCreativeMetaAttribution } from '@/lib/creatives/attribution';
import * as meta from '@/lib/meta/client';
import { CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS } from '@/lib/creatives/human-review';
import type { CreativeRecord } from '@/lib/creatives/generated';

const requireOperatorAccess = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess }));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: vi.fn(), isSafeCreativeId: (id: string) => /^creative_[a-f0-9]{32}$/.test(id) }));
vi.mock('@/lib/creatives/attribution', () => ({ recordCreativeMetaAttribution: vi.fn() }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({ readImageById: vi.fn(async (id: string) => ({ id, fileName: `${id}.png`, mimeType: 'image/png', buffer: Buffer.from('fixture') })) }) }));
vi.mock('@/lib/meta/client', () => ({
  listMetaPromotablePages: vi.fn(), createPausedMetaCampaign: vi.fn(), createPausedMetaAdSet: vi.fn(),
  uploadMetaAdImage: vi.fn(), createMetaAdCreative: vi.fn(), createPausedMetaAd: vi.fn(),
  MetaApiError: class extends Error {},
}));
const id = (hex: string) => `creative_${hex.repeat(32)}`;
const saved = (hex = 'a'): CreativeRecord => ({
  id: id(hex), createdAt: '2026-09-07T00:00:00.000Z', category: 'feature-led', format: 'direct-response', source: 'uploaded',
  image: { id: `media_${hex.repeat(32)}`, fileName: `media_${hex.repeat(32)}.png`, originalName: 'fixture.png', mimeType: 'image/png', url: '/fixture.png', size: 7 },
  copy: { headline: 'Reviewed headline', primaryText: 'Reviewed copy', description: 'Reviewed description' },
  humanReview: { status: 'APPROVED', reviewedAt: '2026-09-07T01:00:00.000Z', checklist: Object.fromEntries(CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS.map(key => [key, 'PASS'])) as never },
  lifecycle: { status: 'ACTIVE', updatedAt: '2026-09-07T00:00:00.000Z' },
});
const request = (extra: object = {}) => new Request('http://localhost/api/meta/publish', { method: 'POST', body: JSON.stringify({ adAccountId: 'act_fixture', pageId: 'page_fixture', destinationUrl: 'https://example.com', dailyBudgetCents: 2000, creativeIds: [id('a')], ...extra }) });
const expectNoMetaCalls = () => {
  for (const call of [meta.listMetaPromotablePages, meta.createPausedMetaCampaign, meta.createPausedMetaAdSet, meta.uploadMetaAdImage, meta.createMetaAdCreative, meta.createPausedMetaAd]) expect(call).not.toHaveBeenCalled();
  expect(recordCreativeMetaAttribution).not.toHaveBeenCalled();
};
beforeEach(() => {
  vi.resetAllMocks();
  requireOperatorAccess.mockResolvedValue(null);
  vi.mocked(listCreatives).mockResolvedValue([saved()]);
  vi.mocked(meta.listMetaPromotablePages).mockResolvedValue([{ id: 'page_fixture', name: 'Fixture page' }] as never);
  vi.mocked(meta.createPausedMetaCampaign).mockResolvedValue('campaign');
  vi.mocked(meta.createPausedMetaAdSet).mockResolvedValue('adset');
  vi.mocked(meta.uploadMetaAdImage).mockResolvedValue('imagehash');
  vi.mocked(meta.createMetaAdCreative).mockResolvedValue('meta-creative');
  vi.mocked(meta.createPausedMetaAd).mockResolvedValue('ad');
});
describe('canonical human-reviewed Meta release', () => {
  it.each([undefined, [], [id('a'), id('a')], ['upload_invalid'], [null], Array(31).fill(id('a'))])('rejects invalid ID selection before any Meta call: %j', async creativeIds => {
    expect((await POST(request({ creativeIds }))).status).toBe(400);
    expectNoMetaCalls();
  });
  it.each(['missing', 'legacy', 'pending', 'rejected', 'paused', 'format'] as const)('blocks the entire mixed batch for %s records', async state => {
    const other = saved('b');
    if (state === 'legacy') delete other.humanReview;
    if (state === 'pending') other.humanReview = { status: 'PENDING' };
    if (state === 'rejected' && other.humanReview?.status === 'APPROVED') other.humanReview = { ...other.humanReview, status: 'REJECTED', checklist: { ...other.humanReview.checklist, placementSafety: 'FAIL' } };
    if (state === 'paused') other.lifecycle = { ...other.lifecycle!, status: 'PAUSED' };
    if (state === 'format') delete other.format;
    vi.mocked(listCreatives).mockResolvedValue(state === 'missing' ? [saved()] : [saved(), other]);
    const response = await POST(request({ creativeIds: [id('a'), id('b')] }));
    expect(response.status).toBe(409);
    expect((await response.json()).blocked).toEqual([{ id: id('b'), reason: expect.any(String) }]);
    expectNoMetaCalls();
  });
  it('uses canonical approved image, copy and source even when stale client content is supplied', async () => {
    const response = await POST(request({ creatives: [{ id: id('a'), imageId: 'wrong', copy: { headline: 'Unreviewed' }, source: 'generated' }] }));
    expect(response.status).toBe(200);
    expect(meta.uploadMetaAdImage).toHaveBeenCalledWith('act_fixture', expect.objectContaining({ id: saved().image.id }));
    expect(meta.createMetaAdCreative).toHaveBeenCalledWith(expect.objectContaining({ headline: 'Reviewed headline', primaryText: 'Reviewed copy', description: 'Reviewed description', name: expect.stringContaining('Upload') }));
    expect(recordCreativeMetaAttribution).toHaveBeenCalledWith(expect.objectContaining({ creativeId: id('a'), mediaId: saved().image.id, source: 'uploaded' }));
    expect(await response.json()).toMatchObject({ campaignStatus: 'PAUSED', adSetStatus: 'PAUSED', results: [{ adStatus: 'PAUSED' }] });
  });
  it('fails closed before any Meta call when canonical storage is unavailable', async () => {
    vi.mocked(listCreatives).mockRejectedValue(new Error('Storage unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await POST(request())).status).toBe(500);
    expectNoMetaCalls();
    log.mockRestore();
  });
});
