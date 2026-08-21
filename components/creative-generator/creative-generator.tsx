'use client';

import { useEffect, useRef, useState } from 'react';
import { applyBrandLogoToCreatives } from '@/lib/creatives/brand-logo';
import { readStoredBrandGuidance } from '@/lib/creatives/brand-guidance';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import type { UploadMode } from '@/lib/creatives/generate-request';
import { consumeLandingCreativeDraft } from '@/lib/creatives/landing-draft';
import type { MediaAsset } from '@/lib/media/types';
import { CompanyView } from '@/components/company/company-view';
import { CreativeComposer } from '@/components/creative-generator/creative-composer';
import { CreativeResults } from '@/components/creative-generator/creative-results';
import { DirectCreativeUploader } from '@/components/creative-generator/direct-creative-uploader';
import createStyles from '@/components/creative-generator/creative-create-mode.module.css';
import { ReferenceLibrary } from '@/components/reference-library/reference-library';

type WorkspaceSection = 'upload' | 'company' | 'reference-images';
type CreationMode = 'generate' | 'direct-upload';
type CreativeGenerationPayload = {
  creatives?: GeneratedCreative[];
  error?: string;
};

const NAV_ITEMS: Array<{
  id: WorkspaceSection;
  label: string;
  shortLabel: string;
  icon: string;
}> = [
  { id: 'upload', label: 'Create', shortLabel: 'Create', icon: '+' },
  { id: 'company', label: 'Company', shortLabel: 'Company', icon: 'C' },
  { id: 'reference-images', label: 'Reference Images', shortLabel: 'References', icon: 'R' },
];

const parseGenerationResponse = async (
  response: Response
): Promise<CreativeGenerationPayload> => {
  const raw = await response.text();
  if (!raw.trim()) {
    return {
      error: `Creative generation returned an empty server response (HTTP ${response.status}).`,
    };
  }

  try {
    return JSON.parse(raw) as CreativeGenerationPayload;
  } catch {
    return {
      error: response.ok
        ? 'Creative generation returned an invalid server response.'
        : `Creative generation was interrupted by the server before it could return a normal response (HTTP ${response.status}).`,
    };
  }
};

export function CreativeGenerator() {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('upload');
  const [creationMode, setCreationMode] = useState<CreationMode>('generate');
  const [media, setMedia] = useState<MediaAsset | null>(null);
  const [uploadMode, setUploadMode] = useState<UploadMode>('tra');
  const [context, setContext] = useState('');
  const [variationCount, setVariationCount] = useState(4);
  const [creatives, setCreatives] = useState<GeneratedCreative[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [handoffGenerate, setHandoffGenerate] = useState(false);
  const handoffConsumedRef = useRef(false);
  const handoffGenerationStartedRef = useRef(false);

  const ready = Boolean(context.trim());

  useEffect(() => {
    if (handoffConsumedRef.current) return;
    handoffConsumedRef.current = true;

    const draft = consumeLandingCreativeDraft();
    if (!draft) return;

    setActiveSection('upload');
    setCreationMode('generate');
    setMedia(draft.media);
    setUploadMode(draft.uploadMode);
    setContext(draft.context);
    setVariationCount(draft.variationCount);
    setCreatives([]);
    setGenerationError('');
    setHandoffGenerate(draft.generateOnOpen);
  }, []);

  const handleUploadStart = () => {
    setMedia(null);
    setCreatives([]);
    setGenerationError('');
  };

  const handleUploaded = (nextMedia: MediaAsset) => {
    setMedia(nextMedia);
    setCreatives([]);
    setGenerationError('');
  };

  const handleDirectUploaded = (nextCreatives: GeneratedCreative[]) => {
    setCreatives(nextCreatives);
    setGenerationError('');
  };

  const switchCreationMode = (nextMode: CreationMode) => {
    if (nextMode === creationMode) return;
    setCreationMode(nextMode);
    setCreatives([]);
    setGenerationError('');
    setGenerating(false);
  };

  const generate = async () => {
    if (!context.trim() || generating) return;

    setGenerating(true);
    setGenerationError('');
    setCreatives([]);

    try {
      const brand = readStoredBrandGuidance();
      const response = await fetch('/api/creatives/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(media ? { mediaId: media.id } : {}),
          ...(brand.logo ? { brandLogoMediaId: brand.logo.mediaId } : {}),
          ...(brand.colors.length ? { brandColors: brand.colors } : {}),
          ...(brand.fontGuidance.length
            ? { brandFontNames: brand.fontGuidance }
            : {}),
          uploadMode,
          context: context.trim(),
          variationCount,
        }),
      });
      const payload = await parseGenerationResponse(response);

      if (!response.ok) {
        throw new Error(payload.error || 'Creative generation failed.');
      }

      if (!Array.isArray(payload.creatives)) {
        throw new Error(
          payload.error || 'Creative generation returned an invalid response.'
        );
      }

      let nextCreatives = payload.creatives;
      if (brand.logo && nextCreatives.length) {
        nextCreatives = await applyBrandLogoToCreatives(
          nextCreatives,
          brand.logo.url
        );
      }

      setCreatives(nextCreatives);
    } catch (error) {
      setGenerationError(
        error instanceof Error ? error.message : 'Creative generation failed.'
      );
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    if (
      !handoffGenerate ||
      !context.trim() ||
      generating ||
      handoffGenerationStartedRef.current
    ) {
      return;
    }

    handoffGenerationStartedRef.current = true;
    setHandoffGenerate(false);
    void generate();
  }, [handoffGenerate, context, media, uploadMode, variationCount]);

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
            <div className="generator-grid">
              <div className="generator-main">
                <div className={createStyles.modeSwitch} aria-label="Creative source">
                  <button
                    type="button"
                    className={`${createStyles.modeButton} ${
                      creationMode === 'generate' ? createStyles.modeButtonActive : ''
                    }`}
                    onClick={() => switchCreationMode('generate')}
                  >
                    Generate with AI
                  </button>
                  <button
                    type="button"
                    className={`${createStyles.modeButton} ${
                      creationMode === 'direct-upload' ? createStyles.modeButtonActive : ''
                    }`}
                    onClick={() => switchCreationMode('direct-upload')}
                  >
                    Upload finished creatives
                  </button>
                </div>

                {creationMode === 'generate' ? (
                  <CreativeComposer
                    value={context}
                    onChange={setContext}
                    onUploadStart={handleUploadStart}
                    onUploaded={handleUploaded}
                    initialMedia={media}
                    uploadMode={uploadMode}
                    onUploadModeChange={setUploadMode}
                    variationCount={variationCount}
                    onVariationCountChange={setVariationCount}
                    onSubmit={generate}
                    ready={ready}
                    generating={generating}
                  />
                ) : (
                  <DirectCreativeUploader
                    onUploadStart={handleUploadStart}
                    onUploaded={handleDirectUploaded}
                  />
                )}

                {generationError ? (
                  <p className="error-message generation-error">{generationError}</p>
                ) : null}
              </div>
            </div>

            <CreativeResults
              creatives={creatives}
              generating={creationMode === 'generate' && generating}
              requestedCount={variationCount}
            />
          </div>
        ) : activeSection === 'company' ? (
          <div className="workspace-view">
            <CompanyView />
          </div>
        ) : (
          <div className="workspace-view">
            <ReferenceLibrary />
          </div>
        )}
      </section>
    </main>
  );
}