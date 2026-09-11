import { getMediaStorage } from '@/lib/media/local-storage';
import { hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import { MAX_APPROVED_HUMAN_OPTIONS, type ApprovedHumanOption } from '@/lib/video/approved-human';
import { listApprovedHumanFrames } from '@/lib/video/approved-human-store';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { videoSourceHash } from '@/lib/video/library-service';
import { isDurableVideoIntelligenceAvailable } from '@/lib/video/preview-availability';
import { loadVideoSelectionContext } from '@/lib/video/selection-context';

/** Curated notes are planning options, never factual proof or provider pixels. */
export async function loadApprovedHumanOptions(): Promise<ApprovedHumanOption[]> {
  if (!isDurableVideoIntelligenceAvailable()) return [];
  let available: Awaited<ReturnType<typeof listApprovedHumanFrames>>;
  try { available = await listApprovedHumanFrames(); }
  catch {
    console.warn('Approved-human catalog unavailable; planning without library human options.');
    return [];
  }
  const records = available.filter(record => record.active)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 24);
  const sourceContexts = new Map<string, Promise<{ hash: string; context: Awaited<ReturnType<typeof loadVideoSelectionContext>> } | null>>();
  const result: ApprovedHumanOption[] = [];
  const pngs = new Set<string>();
  for (const record of records) {
    const mediaId = record.source.sourceVideoMediaId;
    if (!sourceContexts.has(mediaId)) {
      if (sourceContexts.size >= MAX_APPROVED_HUMAN_OPTIONS) continue;
      sourceContexts.set(mediaId, (async () => {
        try {
          const [source] = await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId, role: 'TRA_VIDEO' }]);
          const video = source as HydratedTraVideoSource;
          return { hash: videoSourceHash(video), context: await loadVideoSelectionContext(video) };
        } catch { return null; } // An unavailable source cannot be offered; graphic planning remains possible.
      })());
    }
    const loaded = await sourceContexts.get(mediaId)!;
    const expected = record.source.frames[0];
    const frame = loaded?.context?.library.representativeFrames.find(item => item.id === expected.libraryFrameId);
    if (!loaded || loaded.hash !== record.source.sourceVideoContentHash || loaded.context?.library.id !== record.source.libraryId
      || !frame || frame.frameSha256 !== expected.candidateFrameSha256 || frame.timestampMs !== expected.timestampMs
      || pngs.has(expected.approvedPngSha256)) continue;
    pngs.add(expected.approvedPngSha256);
    result.push({ id: record.id, sourceName: record.sourceName, description: record.description });
    if (result.length === MAX_APPROVED_HUMAN_OPTIONS) break;
  }
  return result;
}
