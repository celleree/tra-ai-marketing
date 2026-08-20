'use client';

import { useState } from 'react';
import type { CreativeCategoryId } from '@/lib/creative-categories';
import type { CreativeFormatId } from '@/lib/creative-formats';
import type { CreativeCopy, GeneratedCreative } from '@/lib/creatives/generated';
import type { MediaAsset } from '@/lib/media/types';
import { ContextInput } from '@/components/creative-generator/context-input';
import { CreativeResults } from '@/components/creative-generator/creative-results';
import { GenerateControls } from '@/components/creative-generator/generate-controls';
import { ImageUpload } from '@/components/creative-generator/image-upload';

interface ApiFailure {
  error?: string;
  stage?: string;
  detail?: string;
}

interface PreparedCreative {
  index: number;
  category: CreativeCategoryId;
  format: CreativeFormatId;
  copy: CreativeCopy;
}

interface PlanningResponse extends ApiFailure {
  mediaId?: string;
  context?: string;
  analysis?: unknown;
  preparedCreatives?: PreparedCreative[];
}

interface RenderResponse extends ApiFailure {
  creative?: GeneratedCreative;
}

const RENDER_CONCURRENCY = 3;

const apiErrorMessage = (payload: ApiFailure, fallback: string) => {
  const parts = [payload.error || fallback];
  if (payload.stage) parts.push(`Stage: ${payload.stage}.`);
  if (payload.detail) parts.push(payload.detail);
  return parts.join(' ');
};

const readJsonResponse = async <T extends ApiFailure>(
  response: Response,
  fallback: string
): Promise<T> => {
  const responseText = await response.text();
  let payload = {} as T;

  if (responseText) {
    try {
      payload = JSON.parse(responseText) as T;
    } catch {
      throw new Error(
        response.ok
          ? 'The server returned an invalid response.'
          : `${fallback} Request status: ${response.status}.`
      );
    }
  }

  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, fallback));
  }

  return payload;
};

export function CreativeGenerator() {
  const [media, setMedia] = useState<MediaAsset | null>(null);
  const [context, setContext] = useState('');
  const [variationCount, setVariationCount] = useState(5);
  const [creatives, setCreatives] = useState<GeneratedCreative[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState('');
  const [generationError, setGenerationError] = useState('');

  const ready = Boolean(media && context.trim());

  const handleUploaded = (nextMedia: MediaAsset) => {
    setMedia(nextMedia);
    setCreatives([]);
    setGenerationProgress('');
    setGenerationError('');
  };

  const generate = async () => {
    if (!media || !context.trim()) return;

    setGenerating(true);
    setGenerationError('');
    setCreatives([]);
    setGenerationProgress(`Planning ${variationCount} creatives…`);

    try {
      const planResponse = await fetch('/api/creatives/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaId: media.id,
          context: context.trim(),
          variationCount,
        }),
      });
      const plan = await readJsonResponse<PlanningResponse>(
        planResponse,
        'Creative planning failed.'
      );

      if (
        !plan.mediaId ||
        !plan.context ||
        !plan.analysis ||
        !Array.isArray(plan.preparedCreatives) ||
        plan.preparedCreatives.length === 0
      ) {
        throw new Error('The creative plan response was incomplete.');
      }

      const prepared = plan.preparedCreatives;
      let cursor = 0;
      let finished = 0;
      let successful = 0;
      const failures: string[] = [];

      setGenerationProgress(`Rendering 0/${prepared.length} creatives…`);

      const worker = async () => {
        while (true) {
          const position = cursor;
          cursor += 1;
          if (position >= prepared.length) return;

          const item = prepared[position];

          try {
            const renderResponse = await fetch('/api/creatives/render', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mediaId: plan.mediaId,
                context: plan.context,
                analysis: plan.analysis,
                creative: item,
              }),
            });
            const rendered = await readJsonResponse<RenderResponse>(
              renderResponse,
              `Variation ${item.index} failed.`
            );

            if (!rendered.creative) {
              throw new Error(`Variation ${item.index} returned no creative.`);
            }

            successful += 1;
            setCreatives((current) =>
              [...current, rendered.creative!].sort((a, b) => a.index - b.index)
            );
          } catch (error) {
            failures.push(
              error instanceof Error
                ? error.message
                : `Variation ${item.index} failed.`
            );
          } finally {
            finished += 1;
            setGenerationProgress(
              `Rendering ${finished}/${prepared.length} creatives…`
            );
          }
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(RENDER_CONCURRENCY, prepared.length) },
          () => worker()
        )
      );

      if (failures.length > 0) {
        setGenerationError(
          `Generated ${successful} of ${prepared.length}. ${failures[0]}`
        );
      }

      setGenerationProgress(
        failures.length > 0
          ? `Finished with ${successful}/${prepared.length} creatives.`
          : `Generated ${successful}/${prepared.length} creatives.`
      );
    } catch (error) {
      setGenerationError(
        error instanceof Error ? error.message : 'Creative generation failed.'
      );
      setGenerationProgress('');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">TRA AI Marketing</p>
        <h1>Turn one image into multiple ad concepts.</h1>
        <p className="hero-copy">
          Upload a source image, add a short instruction, then generate multiple
          TRA ad concepts across different messaging categories.
        </p>
      </header>

      {media ? (
        <section className="uploaded-banner">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={media.url} alt="Uploaded source" />
          <div>
            <strong>Image uploaded</strong>
            <p>{media.originalName}</p>
          </div>
          <span className="status-pill">Ready</span>
        </section>
      ) : null}

      <div className="generator-grid">
        <div className="generator-main">
          <ImageUpload onUploaded={handleUploaded} />
          <ContextInput value={context} onChange={setContext} />
        </div>
        <aside>
          <GenerateControls
            variationCount={variationCount}
            onVariationCountChange={setVariationCount}
            onGenerate={generate}
            ready={ready}
            generating={generating}
            progress={generationProgress}
          />
          {generationError ? (
            <p className="error-message generation-error">{generationError}</p>
          ) : null}
        </aside>
      </div>

      <CreativeResults creatives={creatives} />
    </main>
  );
}
