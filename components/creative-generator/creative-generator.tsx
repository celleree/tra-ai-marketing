'use client';

import { useState } from 'react';
import type { MediaAsset } from '@/lib/media/types';
import { ContextInput } from '@/components/creative-generator/context-input';
import { GenerateControls } from '@/components/creative-generator/generate-controls';
import { ImageUpload } from '@/components/creative-generator/image-upload';

export function CreativeGenerator() {
  const [media, setMedia] = useState<MediaAsset | null>(null);
  const [context, setContext] = useState('');
  const [variationCount, setVariationCount] = useState(4);

  const ready = Boolean(media && context.trim());

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">TRA AI Marketing</p>
        <h1>Turn one image into multiple ad concepts.</h1>
        <p className="hero-copy">
          Upload a source image, add a short instruction, then generate multiple
          TRA ad variations and copy from the same starting point.
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
          <ImageUpload onUploaded={setMedia} />
          <ContextInput value={context} onChange={setContext} />
        </div>
        <aside>
          <GenerateControls
            variationCount={variationCount}
            onVariationCountChange={setVariationCount}
            ready={ready}
          />
        </aside>
      </div>
    </main>
  );
}
