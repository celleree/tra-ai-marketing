'use client';

import { useEffect, useRef, useState } from 'react';
import { CompanyView } from '@/components/company/company-view';
import { CreativeLibrary } from '@/components/creative-library/creative-library';
import { CreativeComposer } from '@/components/creative-generator/creative-composer';
import { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
import { PortfolioProgressPanel } from '@/components/creative-generator/portfolio-progress-panel';
import { portfolioCanAdvance } from '@/lib/creatives/portfolio-client';
import type { CreativePlacement } from '@/lib/creatives/placements';
import { CreativeResults } from '@/components/creative-generator/creative-results';
import { DirectCreativeUploader } from '@/components/creative-generator/direct-creative-uploader';
import createStyles from '@/components/creative-generator/creative-create-mode.module.css';
import { ReferenceLibrary } from '@/components/reference-library/reference-library';
import { ProofLibrary } from '@/components/proof-library/proof-library';
import { readStoredRuntimeCompanyProfile } from '@/lib/company/creative-context';
import { readStoredBrandGuidance } from '@/lib/creatives/brand-guidance';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import { consumeLandingCreativeDraft } from '@/lib/creatives/landing-draft';
import type {
  CreativeSourceAsset,
  CreativeSourceRole,
} from '@/lib/media/types';

type WorkspaceSection = 'upload' | 'tra-creatives' | 'company' | 'proof-library' | 'reference-images';
type CreationMode = 'generate' | 'direct-upload';

const NAV_ITEMS: Array<{
  id: WorkspaceSection;
  label: string;
  shortLabel: string;
  icon: string;
}> = [
  { id: 'upload', label: 'Create', shortLabel: 'Create', icon: '+' },
  { id: 'tra-creatives', label: 'TRA Creatives', shortLabel: 'Creatives', icon: 'T' },
  { id: 'company', label: 'Company', shortLabel: 'Company', icon: 'C' },
  { id: 'proof-library', label: 'Proof Library', shortLabel: 'Proof', icon: 'P' },
  { id: 'reference-images', label: 'Reference Images', shortLabel: 'References', icon: 'R' },
];

const SECTION_HEADERS: Record<
  WorkspaceSection,
  { eyebrow: string; title: string; description: string }
> = {
  upload: {
    eyebrow: 'Creative studio',
    title: 'Create',
    description: 'Generate new TRA creatives with AI or upload finished ads.',
  },
  'tra-creatives': {
    eyebrow: 'TRA creative library',
    title: 'Creatives',
    description: 'Review, revise, and manage saved generated and uploaded TRA creatives.',
  },
  company: {
    eyebrow: 'Company intelligence',
    title: 'Company',
    description:
      'Manage the verified company profile, brand guidance, and guardrails used by the creative system.',
  },
  'proof-library': {
    eyebrow: 'Verified evidence',
    title: 'Proof Library',
    description: 'Manage exact customer reviews and approved case-study evidence.',
  },
  'reference-images': {
    eyebrow: 'Reference library',
    title: 'References',
    description:
      'Manage layout inspiration and TRA-owned source imagery used for new creatives.',
  },
};

function WorkspaceSectionHeader({ section }: { section: WorkspaceSection }) {
  const header = SECTION_HEADERS[section];

  return (
    <header className="workspace-section-header">
      <p className="workspace-section-eyebrow">{header.eyebrow}</p>
      <h1>{header.title}</h1>
      <p>{header.description}</p>
    </header>
  );
}

export function CreativeGenerator() {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('upload');
  const [creationMode, setCreationMode] = useState<CreationMode>('generate');
  const [sourceAssets, setSourceAssets] = useState<CreativeSourceAsset[]>([]);
  const [context, setContext] = useState('');
  const [variationCount, setVariationCount] = useState(4);
  const [placement, setPlacement] = useState<CreativePlacement>('SQUARE_1_1');
  const [uploadedCreatives, setCreatives] = useState<GeneratedCreative[]>([]);
  const [generationError, setGenerationError] = useState('');
  const [handoffGenerate, setHandoffGenerate] = useState(false);
  const handoffConsumedRef = useRef(false);
  const handoffGenerationStartedRef = useRef(false);
  const portfolio = useCreativePortfolio();
  const generating = portfolio.running;
  const savedPortfolio = portfolio.response?.job;
  const creatives = creationMode === 'generate' ? portfolio.response?.creatives ?? [] : uploadedCreatives;
  const generationComplete = !savedPortfolio || (!generating && !portfolioCanAdvance(savedPortfolio));
  const generationFailures = Object.fromEntries((savedPortfolio?.slots ?? [])
    .filter(slot => slot.status === 'RETRY_REQUIRED').map(slot => [slot.index, slot.error || 'Could not be completed.']));
  const displayGenerationError = creationMode === 'generate' ? portfolio.error || generationError : generationError;

  const ready = Boolean(context.trim());

  useEffect(() => {
    if (handoffConsumedRef.current) return;
    handoffConsumedRef.current = true;

    const draft = consumeLandingCreativeDraft();
    if (!draft) { void portfolio.restoreSaved(); return; }

    setActiveSection('upload');
    setCreationMode('generate');
    setSourceAssets(draft.sourceAsset ? [draft.sourceAsset] : []);
    setContext(draft.context);
    setVariationCount(draft.variationCount);
    setCreatives([]);
    setGenerationError('');
    setHandoffGenerate(draft.generateOnOpen);
  }, []);

  const handleUploadStart = () => {
    setCreatives([]);
    setGenerationError('');
  };

  const handleUploaded = (source: CreativeSourceAsset) => {
    setSourceAssets((current) => [...current, source]);
    setCreatives([]);
    setGenerationError('');
  };

  const handleSourceRoleChange = (
    mediaId: string,
    role: CreativeSourceRole
  ) => {
    setSourceAssets((current) =>
      current.map((source) =>
        source.media.id === mediaId ? { ...source, role } : source
      )
    );
    setCreatives([]);
    setGenerationError('');
  };

  const handleSourceRemoved = (mediaId: string) => {
    setSourceAssets((current) =>
      current.filter((source) => source.media.id !== mediaId)
    );
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
  };

  const generate = async () => {
    if (!context.trim() || generating) return;
    setGenerationError('');
    try {
      const brand = readStoredBrandGuidance();
      const companyProfile = readStoredRuntimeCompanyProfile();
      await portfolio.start({
        sourceAssets: sourceAssets.map(source => ({ mediaId: source.media.id, role: source.role })),
        ...(brand.logo ? { brandLogoMediaId: brand.logo.mediaId } : {}),
        ...(brand.colors.length ? { brandColors: brand.colors } : {}),
        ...(brand.fontGuidance.length ? { brandFontNames: brand.fontGuidance } : {}),
        ...(companyProfile ? { companyProfile } : {}),
        context: context.trim(), variationCount, placement,
      });
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : 'Creative generation failed.');
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
  }, [handoffGenerate, context, sourceAssets, variationCount]);

  return (
    <main className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <div className="workspace-brand-mark">TRA</div>
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
        {activeSection === 'upload' ? (
          <div className="workspace-view workspace-view-upload">
            <WorkspaceSectionHeader section="upload" />

            <div className="generator-grid">
              <div className="generator-main">
                <div className={createStyles.modeSwitch} aria-label="Creative source">
                  <button
                    type="button"
                    className={`${createStyles.modeButton} ${
                      creationMode === 'generate' ? createStyles.modeButtonActive : ''
                    }`}
                    disabled={generating}
                    onClick={() => switchCreationMode('generate')}
                  >
                    Generate with AI
                  </button>
                  <button
                    type="button"
                    className={`${createStyles.modeButton} ${
                      creationMode === 'direct-upload' ? createStyles.modeButtonActive : ''
                    }`}
                    disabled={generating}
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
                    sourceAssets={sourceAssets}
                    onSourceRoleChange={handleSourceRoleChange}
                    onSourceRemoved={handleSourceRemoved}
                    variationCount={variationCount}
                    onVariationCountChange={setVariationCount}
                    placement={placement}
                    onPlacementChange={setPlacement}
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

                {creationMode === 'generate' ? <PortfolioProgressPanel portfolio={portfolio} /> : null}
                {displayGenerationError ? (
                  <p className="error-message generation-error">{displayGenerationError}</p>
                ) : null}
              </div>
            </div>

            <CreativeResults
              creatives={creatives}
              generating={creationMode === 'generate' && generating}
              requestedCount={creationMode === 'generate' ? savedPortfolio?.requestedCount ?? variationCount : variationCount}
              generationComplete={
                creationMode !== 'generate' || generationComplete
              }
              generationFailures={creationMode === 'generate' ? generationFailures : {}}
            />
          </div>
        ) : activeSection === 'tra-creatives' ? (
          <div className="workspace-view workspace-view-standard">
            <WorkspaceSectionHeader section="tra-creatives" />
            <CreativeLibrary />
          </div>
        ) : activeSection === 'company' ? (
          <div className="workspace-view workspace-view-standard">
            <WorkspaceSectionHeader section="company" />
            <CompanyView />
          </div>
        ) : activeSection === 'proof-library' ? (
          <div className="workspace-view workspace-view-standard">
            <WorkspaceSectionHeader section="proof-library" />
            <ProofLibrary />
          </div>
        ) : (
          <div className="workspace-view workspace-view-standard">
            <WorkspaceSectionHeader section="reference-images" />
            <ReferenceLibrary />
          </div>
        )}
      </section>
    </main>
  );
}
