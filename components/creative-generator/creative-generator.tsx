'use client';

import { useState } from 'react';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import type { MediaAsset } from '@/lib/media/types';
import { ContextInput } from '@/components/creative-generator/context-input';
import { CreativeResults } from '@/components/creative-generator/creative-results';
import { GenerateControls } from '@/components/creative-generator/generate-controls';
import { ImageUpload } from '@/components/creative-generator/image-upload';

type WorkspaceSection =
  | 'upload'
  | 'knowledge-base'
  | 'brand-guidelines'
  | 'reference-images';

const NAV_ITEMS: Array<{
  id: WorkspaceSection;
  label: string;
  shortLabel: string;
  icon: string;
}> = [
  { id: 'upload', label: 'Create', shortLabel: 'Create', icon: '+' },
  { id: 'knowledge-base', label: 'Knowledge Base', shortLabel: 'Knowledge', icon: 'K' },
  { id: 'brand-guidelines', label: 'Brand Guidelines', shortLabel: 'Brand', icon: 'B' },
  { id: 'reference-images', label: 'Reference Images', shortLabel: 'References', icon: 'R' },
];

export function CreativeGenerator() {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('upload');
  const [media, setMedia] = useState<MediaAsset | null>(null);
  const [context, setContext] = useState('');
  const [variationCount, setVariationCount] = useState(4);
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
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Creative generation failed.');
      }

      setCreatives((payload.creatives || []) as GeneratedCreative[]);
    } catch (error) {
      setGenerationError(
        error instanceof Error ? error.message : 'Creative generation failed.'
      );
    } finally {
      setGenerating(false);
    }
  };

  const activeLabel =
    NAV_ITEMS.find((item) => item.id === activeSection)?.label || 'Create';

  return (
    <main className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <div className="workspace-brand-mark">TRA</div>
          <div>
            <strong>AI Marketing</strong>
            <span>Creative Studio</span>
          </div>
        </div>

        <nav className="workspace-nav" aria-label="Creative workspace">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`workspace-nav-item ${
                activeSection === item.id ? 'workspace-nav-item-active' : ''
              }`}
              onClick={() => setActiveSection(item.id)}
            >
              <span className="workspace-nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="workspace-nav-label">{item.label}</span>
              <span className="workspace-nav-short-label">{item.shortLabel}</span>
            </button>
          ))}
        </nav>

        <div className="workspace-sidebar-footer">
          <span className="workspace-status-dot" />
          TRA workspace
        </div>
      </aside>

      <section className="workspace-content">
        <header className="workspace-topbar">
          <div>
            <p className="workspace-kicker">TRA AI Marketing</p>
            <h1>{activeLabel}</h1>
          </div>
          <div className="workspace-badge">Internal</div>
        </header>

        {activeSection === 'upload' ? (
          <div className="workspace-view workspace-view-upload">
            <div className="workspace-intro">
              <p className="workspace-kicker">Creative generator</p>
              <h2>Turn one TRA creative into the next batch.</h2>
              <p>
                Upload a source creative, add direction, and generate new concepts
                across different ad formats.
              </p>
            </div>

            {media ? (
              <section className="uploaded-banner">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={media.url} alt="Uploaded source" />
                <div>
                  <strong>Creative uploaded</strong>
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
              <aside className="generator-controls-column">
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
          </div>
        ) : (
          <div className="workspace-view workspace-empty-view" aria-label={`${activeLabel} workspace`} />
        )}
      </section>
    </main>
  );
}
