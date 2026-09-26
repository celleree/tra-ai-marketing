'use client';

import { createSubmissionIdentity, SUBMISSION_HEADER } from '@/lib/creatives/submission-id';

import { useEffect, useRef, useState } from 'react';
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
  const [previews, setPreviews] = useState<Array<{ frameId: string; timestampMs: number; url: string }>>([]);
  const [previewing, setPreviewing] = useState(false);
  const completedIndexes = useRef(new Set<number>());
  const failedIndexes = useRef(new Map<number, string>());
  const previewAbort = useRef<AbortController | null>(null);
  const previewUrls = useRef<string[]>([]);
  const previewVersion = useRef(0);

  const discardPreviews = () => {
    previewVersion.current += 1;
    previewAbort.current?.abort();
    previewAbort.current = null;
    setPreviewing(false);
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = [];
    setPreviews([]);
  };

  useEffect(() => () => {
    previewAbort.current?.abort();
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const preview = async () => {
    if (generating || previewAbort.current) return;
    const selectedFrames = selection.frames.filter((frame) => selectedFrameIds.includes(frame.frameId));
    if (!selectedFrames.length) return;
    discardPreviews();
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreviewing(true);
    const version = previewVersion.current;
    setError('');
    try {
      const settled = await Promise.allSettled(selectedFrames.map(async ({ frameId }) => {
        const response = await fetch('/api/video/intelligence/selected-frame-preview', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ mediaId: media.id, videoFrameSelection: { libraryId: library.id,
            sourceVideoContentHash: library.sourceVideoContentHash, frameIds: [frameId] } }) });
        if (!response.ok) throw new Error((await response.json()).error || 'Source-frame preview failed.');
        return { frameId, timestampMs: Number(response.headers.get('X-TRA-Frame-Timestamp-Ms')),
          url: URL.createObjectURL(await response.blob()) };
      }));
      const results = settled.filter((result): result is PromiseFulfilledResult<{ frameId: string; timestampMs: number; url: string }> => result.status === 'fulfilled').map((result) => result.value);
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        results.forEach(({ url }) => URL.revokeObjectURL(url));
        throw failure.reason;
      }
      if (controller.signal.aborted || version !== previewVersion.current) {
        results.forEach(({ url }) => URL.revokeObjectURL(url)); return;
      }
      previewUrls.current = results.map(({ url }) => url);
      setPreviews(results);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Source-frame preview failed.');
    } finally {
      if (previewAbort.current === controller) {
        previewAbort.current = null;
        setPreviewing(false);
      }
    }
  };

  const submission = useRef(createSubmissionIdentity('direct-generation'));
  const submitting = useRef(false);
  const generate = async (mode: 'recover' | 'fresh' = 'recover') => {
    if (submitting.current) return;
    const selectedFrames = selection.frames.filter((frame) =>
      selectedFrameIds.includes(frame.frameId)
    );
    const frameIds = selectedFrames.map((frame) => frame.frameId);
    if (frameIds.length < 1 || frameIds.length > 3) {
      setError('Select between 1 and 3 video frames before generating.');
      return;
    }

    submitting.current = true;
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
      const requestBody = JSON.stringify({
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
        });
      const submissionId = await submission.current.forInput(requestBody, mode);
      const response = await fetch('/api/creatives/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SUBMISSION_HEADER]: submissionId },
        body: requestBody,
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
      submission.current.completeGeneration(submissionId, 2, completedIndexes.current.size, failedIndexes.current.size);
      if (failedIndexes.current.size) {
        setError(`Completed ${completedIndexes.current.size} of 2 creatives. ${failedIndexes.current.size} failed.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Creative generation failed.');
    } finally {
      submitting.current = false;
      setGenerating(false);
    }
  };

  const toggleFrame = (frameId: string) => {
    discardPreviews();
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
    <button className={styles.primary} type="button" onClick={() => void preview()} disabled={generating || previewing || selectedFrameIds.length < 1}>{previewing ? 'Extracting source frames…' : 'Preview source frames'}</button>
    <p className={styles.muted}>Extracted from the original video. No image generation.</p>
    {error && !generating ? <button type="button" onClick={() => void generate('fresh')}>
      Start a new paid generation
    </button> : null}
    {previews.length ? <section className={styles.generatedResults}>{previews.map((frame) => <article className={styles.frameChoice} key={frame.frameId}>
      {/* eslint-disable-next-line @next/next/no-img-element */}<img src={frame.url} alt={`Verified source video frame at ${(frame.timestampMs / 1000).toFixed(3)} seconds`} />
      <span><b>{(frame.timestampMs / 1000).toFixed(3)}s</b> Fresh source PNG</span>
    </article>)}</section> : null}
    <CreativePlacementSelect value={placement} onChange={setPlacement} disabled={generating || previewing} />
    <button className={styles.primary} type="button" onClick={() => void generate()} disabled={generating || previewing || selectedFrameIds.length < 1}>
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
