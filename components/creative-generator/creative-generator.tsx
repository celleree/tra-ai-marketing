'use client';

import { useState } from 'react';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import type { MediaAsset } from '@/lib/media/types';
import { ContextInput } from '@/components/creative-generator/context-input';
import { CreativeResults } from '@/components/creative-generator/creative-results';
import { GenerateControls } from '@/components/creative-generator/generate-controls';
import { ImageUpload } from '@/components/creative-generator/image-upload';

interface GenerationResponse {
  creatives?: GeneratedCreative[];
  error?: string;
  stage?: string;
  detail?: string;
}

export function CreativeGenerator() {
  const [media, setMedia] = useState<MediaAsset | null>(null);
  const [context, setContext] = useState('');
  const [variationCount, setVariationCount] = useState(5);
  const [creatives, setCreatives] = useState<GeneratedCreative[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');

  const ready = Boolean(media && context.trim());

  const handleUploaded = (nextMedia: MediaAsset) => {
    setMedia(nextMedia);
    setCreatives([]);
    setGenerationError('');
  };

  const generate = async () => {
    if (!media || !context.trim()) return;

    setGenerating(true);
    setGenerationError('');
    setCreatives([]);

    try {
      const response = await fetch('/api/creatives/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaId: media.id,
          context: context.trim(),
          variationCount,
        }),
      });
      const responseText = await response.text();
      let payload: GenerationResponse = {};

      if (responseText) {
        try {
          payload = JSON.parse(responseText) as GenerationResponse;
        } catch {
          if (!response.ok) {
            throw new Error(`Creative generation request failed with status ${response.status}.`);
          }
        }
      }

      if (!response.ok) {
        const parts = [payload.error || 'Creative generation failed.'];
        if (payload.stage) parts.push(`Stage: ${payload.stage}.`);
        if (payload.detail) parts.push(payload.detail);
        throw new Error(parts.join(' '));
      }

      setCreatives(payload.creatives || []);
    } catch (error) {
      setGenerationError(
        error instanceof Error ? error.message : 'Creative generation failed.'
      );
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
