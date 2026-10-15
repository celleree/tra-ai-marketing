import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ enabled: vi.fn(), list: vi.fn(), hydrate: vi.fn(), hash: vi.fn(), context: vi.fn() }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: vi.fn(() => ({})) }));
vi.mock('@/lib/media/source-hydration', () => ({ hydrateCreativeSourceSelections: mocks.hydrate }));
vi.mock('@/lib/video/approved-human-store', () => ({ listApprovedHumanFrames: mocks.list }));
vi.mock('@/lib/video/library-service', () => ({ videoSourceHash: mocks.hash }));
vi.mock('@/lib/video/preview-availability', () => ({ isDurableVideoIntelligenceAvailable: mocks.enabled }));
vi.mock('@/lib/video/selection-context', () => ({ loadVideoSelectionContext: mocks.context }));
import { loadApprovedHumanOptions } from '@/lib/video/approved-human-planning';

const record = (index = 1) => ({ version: 2, sourceOverlay: { version: 2, status: 'CLEAN' },
  id: `human_${index.toString(16).padStart(64, '0')}`, active: true,
  description: 'Approved visible presenter', sourceName: 'TRA source', updatedAt: '2026-09-10T00:00:00.000Z',
  source: { sourceVideoMediaId: 'source', sourceVideoContentHash: 'hash', libraryId: 'library',
    frames: [{ libraryFrameId: `frame-${index}`, candidateFrameSha256: `candidate-${index}`, timestampMs: index * 1000, approvedPngSha256: `png-${index}` }] } });
const frame = (index: number) => ({ id: `frame-${index}`, frameSha256: `candidate-${index}`, timestampMs: index * 1000 });
beforeEach(() => {
  vi.resetAllMocks(); mocks.enabled.mockReturnValue(true); mocks.list.mockResolvedValue([record()]);
  mocks.hydrate.mockResolvedValue([{}]); mocks.hash.mockReturnValue('hash');
  mocks.context.mockResolvedValue({ library: { id: 'library', representativeFrames: Array.from({length:10}, (_,i)=>frame(i+1)) } });
});
describe('approved-human planning options', () => {
  it('keeps graphic planning available when the optional catalog cannot be read', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.list.mockRejectedValue(new Error('Catalog corrupt or storage unavailable'));
    expect(await loadApprovedHumanOptions()).toEqual([]);
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('without library human options'));
    warning.mockRestore();
  });
  it('offers every valid curated option beyond the legacy eight-option cap and hydrates each shared source once', async () => {
    mocks.list.mockResolvedValue(Array.from({length:10}, (_,i)=>record(i+1)));
    const result = await loadApprovedHumanOptions();
    expect(result).toHaveLength(10); expect(mocks.hydrate).toHaveBeenCalledTimes(1);
    expect(result.map(item => item.id)).toEqual(Array.from({length:10}, (_,i)=>record(i+1).id));
    expect(result[0]).toEqual({id:record().id,sourceName:record().sourceName,description:record().description});
  });
  it('omits inactive, duplicate-PNG and source-mismatched records without inventing replacements', async () => {
    mocks.list.mockResolvedValue([record(), {...record(2),active:false}, {...record(3),source:record().source},
      {...record(4),source:{...record(4).source,sourceVideoContentHash:'changed'}},
      {...record(5),source:{...record(5).source,libraryId:'old-library'}}]);
    expect((await loadApprovedHumanOptions()).map(item=>item.id)).toEqual([record().id]);
  });
  it('omits unavailable or drifted representatives and does not perform new analysis', async () => {
    mocks.hydrate.mockRejectedValueOnce(new Error('Source missing'));
    expect(await loadApprovedHumanOptions()).toEqual([]);
    mocks.context.mockResolvedValueOnce({ library: { id:'library',representativeFrames:[{...frame(1),timestampMs:999}] } });
    expect(await loadApprovedHumanOptions()).toEqual([]);
    mocks.enabled.mockReturnValue(false); mocks.list.mockClear();
    expect(await loadApprovedHumanOptions()).toEqual([]); expect(mocks.list).not.toHaveBeenCalled();
  });
});
