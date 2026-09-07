'use client';

import { useRef, useState } from 'react';
import { CreativePlacementSelect } from '@/components/creative-generator/creative-placement-select';
import type { CreativePlacement } from '@/lib/creatives/placements';
import { readStoredRuntimeCompanyProfile } from '@/lib/company/creative-context';
import { applyBrandLogoToCreatives } from '@/lib/creatives/brand-logo';
import { readStoredBrandGuidance } from '@/lib/creatives/brand-guidance';
import {
  consumeGenerationEventStream,
  isGenerationEventStream,
  parseGenerationResponse,
} from '@/lib/creatives/parse-generation-response';
import {
  completeProgressiveCreative,
  insertCreativeByIndex,
} from '@/lib/creatives/progressive-delivery';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import type { CreativeSourceVideoAsset } from '@/lib/media/types';
import type { VideoConceptSelection } from '@/lib/video/concept-selection';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import styles from './video-intelligence-studio.module.css';

interface SelectedFrameGenerationProps {
  media: CreativeSourceVideoAsset;
  library: VideoFrameLibrary;
  selection: VideoConceptSelection;
}

export function SelectedFrameGeneration({
  media,
  library,
  selection,
}: SelectedFrameGenerationProps) {
  const [selectedFrameIds, setSelectedFrameIds] = useState(() =>
    selection.frames.map((frame) => frame.frameId)
  );
  const [creatives, setCreatives] = useState<GeneratedCreative[]>([]);
  const [generating, setGenerating] = useState(false);
  const [placement, setPlacement] = useState<CreativePlacement>('SQUARE_1_1');
  const [error, setError] = useState('');
  const [savedCount, setSavedCount] = useState(0);
  const [failures, setFailures] = useState<Record<number, string>>({});
  const completedIndexes = useRef(new Set<number>());
  const failedIndexes = useRef(new Map<number, string>());

  const generate = async () => {
    if (generating) return;
    const selectedFrames = selection.frames.filter((frame) =>
      selectedFrameIds.includes(frame.frameId)
    );
    const frameIds = selectedFrames.map((frame) => frame.frameId);
    if (frameIds.length < 1 || frameIds.length > 3) {
      setError('Select between 1 and 3 video frames before generating.');
      return;
    }

    setGenerating(true);
    setError('');
    setFailures({});
    setCreatives([]);
    setSavedCount(0);
    completedIndexes.current = new Set();
    failedIndexes.current = new Map();
    const conceptContext = `Creative concept: ${selection.concept}\n\nSelected-frame rationale (unverified model selection):\n${selectedFrames.map((frame) => `- ${frame.reason}`).join('\n')}`;

    const recordFailure = (index: number, message: string) => {
      failedIndexes.current.set(index, message);
      setFailures(Object.fromEntries(failedIndexes.current));
    };

    try {
      const brand = readStoredBrandGuidance();
      const companyProfile = readStoredRuntimeCompanyProfile();
      const response = await fetch('/api/creatives/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAssets: [{ mediaId: media.id, role: 'TRA_VIDEO' }],
          videoFrameSelection: {
            libraryId: library.id,
            sourceVideoContentHash: library.sourceVideoContentHash,
            frameIds,
          },
          ...(brand.logo ? { brandLogoMediaId: brand.logo.mediaId } : {}),
          ...(brand.colors.length ? { brandColors: brand.colors } : {}),
          ...(brand.fontGuidance.length ? { brandFontNames: brand.fontGuidance } : {}),
          ...(companyProfile ? { companyProfile } : {}),
          context: conceptContext,
          variationCount: 2,
          placement,
        }),
      });
      if (!response.ok || !isGenerationEventStream(response)) {
        const payload = await parseGenerationResponse(response);
        throw new Error(payload.error || `Creative generation failed (HTTP ${response.status}).`);
      }

      let receivedComplete = false;
      await consumeGenerationEventStream(response, async (event) => {
        if (event.type === 'error') {
          if (event.index) recordFailure(event.index, event.error);
          else setError(event.error);
          return;
        }
        if (event.type === 'complete') {
          receivedComplete = true;
          event.failedIndexes.forEach((index) => {
            if (!failedIndexes.current.has(index)) recordFailure(index, `Creative ${index} could not be generated.`);
          });
          return;
        }

        try {
          const creative = await completeProgressiveCreative({
            creative: event.creative,
            ...(brand.logo ? { logoUrl: brand.logo.url } : {}),
            applyBrandLogo: applyBrandLogoToCreatives,
            persist: async (completedCreative) => {
              const saveResponse = await fetch('/api/creatives', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  creatives: [{
                    id: completedCreative.id,
                    image: completedCreative.image,
                    category: completedCreative.category,
                    copy: completedCreative.copy,
                    format: completedCreative.format,
                    placement: completedCreative.placement,
                    planning: completedCreative.planning,
                    generationProvenance: completedCreative.generationProvenance,
                    identity: completedCreative.identity,
                    ...(completedCreative.videoFrameSelection
                      ? { videoFrameSelection: completedCreative.videoFrameSelection }
                      : {}),
                  }],
                }),
              });
              const payload = await saveResponse.json();
              if (!saveResponse.ok) throw new Error(payload.error || 'Generated creative could not be saved.');
            },
          });
          completedIndexes.current.add(creative.index);
          setSavedCount((current) => current + 1);
          setCreatives((current) => insertCreativeByIndex(current, creative));
        } catch (reason) {
          recordFailure(event.creative.index, reason instanceof Error ? reason.message : `Creative ${event.creative.index} could not be completed.`);
        }
      });

      if (!receivedComplete) throw new Error('Creative generation ended before reporting completion.');
      if (failedIndexes.current.size) {
        setError(`Completed ${completedIndexes.current.size} of 2 creatives. ${failedIndexes.current.size} failed.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Creative generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  const toggleFrame = (frameId: string) => {
    setSelectedFrameIds((current) =>
      current.includes(frameId)
        ? current.filter((id) => id !== frameId)
        : current.length < 3 ? [...current, frameId] : current
    );
  };

  return <section className={styles.selectedGeneration}>
    <fieldset className={styles.selectedFrames} disabled={generating}>
      <legend>Choose 1–3 source frames</legend>
      <p className={styles.muted}>Uncheck a poor frame before generating. The raw video stays server-side; selection evidence remains unverified.</p>
      {selection.frames.map((item) => {
        const frame = library.representativeFrames.find((candidate) => candidate.id === item.frameId);
        const checked = selectedFrameIds.includes(item.frameId);
        return <label className={styles.frameChoice} key={item.frameId}>
          <input type="checkbox" checked={checked} onChange={() => toggleFrame(item.frameId)} disabled={!checked && selectedFrameIds.length >= 3} />
          {frame ? <img src={frame.thumbnailDataUrl} alt={`Selected video frame at ${(frame.timestampMs / 1000).toFixed(3)} seconds`} /> : null}
          <span><b>{frame ? `${(frame.timestampMs / 1000).toFixed(3)}s` : 'Frame'}</b>{item.reason}</span>
        </label>;
      })}
    </fieldset>
    <CreativePlacementSelect value={placement} onChange={setPlacement} disabled={generating} />
    <button className={styles.primary} type="button" onClick={() => void generate()} disabled={generating || selectedFrameIds.length < 1}>
      {generating ? 'Generating 2 creatives…' : 'Generate 2 creatives from checked frames (uses API)'}
    </button>
    {savedCount ? <p className={styles.progress} role="status">Saved {savedCount} {savedCount === 1 ? 'creative' : 'creatives'} to the TRA creative library.</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {creatives.length || generating || Object.keys(failures).length ? <section className={styles.generatedResults} aria-live="polite">
      {[1, 2].map((index) => {
        const creative = creatives.find((item) => item.index === index);
        if (creative) return <article className={styles.generatedCreative} key={creative.id}>
          {/* eslint-disable-next-line @next/next/no-img-element */}<img className={styles.generatedCreativeImage} src={creative.image.url} alt={`Generated TRA creative ${index}`} />
          <div><p className={styles.generatedLabel}>Creative {index} · saved to library</p><h3>{creative.copy.headline}</h3><p>{creative.copy.primaryText}</p>{creative.copy.description ? <p>{creative.copy.description}</p> : null}<p className={styles.generatedSource}>Source frames: {creative.videoFrameSelection?.frames.map((frame) => `${(frame.timestampMs / 1000).toFixed(3)}s`).join(', ') || 'selected TRA video frames'}</p></div>
        </article>;
        if (failures[index]) return <article className={styles.generatedFailure} key={index}><strong>Creative {index} could not be completed.</strong><p>{failures[index]}</p></article>;
        return generating ? <article className={styles.generatedPending} key={index}>Generating creative {index}…</article> : null;
      })}
    </section> : null}
  </section>;
}
