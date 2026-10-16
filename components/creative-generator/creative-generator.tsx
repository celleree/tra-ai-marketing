'use client';

import { readSelectedCompanyReferenceIds } from '@/lib/company/reference-selection';

import { useEffect, useRef, useState } from 'react';
import { CompanyView } from '@/components/company/company-view';
import { CreativeLibrary } from '@/components/creative-library/creative-library';
import { SavedVideoReviewSummary, VideoReviewPanel } from '@/components/creative-generator/video-review-panel';
import { CreativeComposer } from '@/components/creative-generator/creative-composer';
import { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
import { useSavedVideoSources } from '@/components/creative-generator/use-saved-video-sources';
import { useVideoReviewDraft } from '@/components/creative-generator/use-video-review-draft';
import { PortfolioPortraitDiagnosticAction } from '@/components/creative-generator/portfolio-portrait-diagnostic';
import { PortfolioProgressPanel } from '@/components/creative-generator/portfolio-progress-panel';
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
  { id: 'tra-creatives', label: 'Creatives', shortLabel: 'Creatives', icon: 'C' },
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
    description: 'Generate new company creatives with AI or upload finished ads.',
  },
  'tra-creatives': {
    eyebrow: 'Company creative library',
    title: 'Creatives',
    description: 'Review, revise, and manage saved generated and uploaded company creatives.',
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
      'Manage layout inspiration and company-owned source imagery used for new creatives.',
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

export function CreativeGenerator({ acceptancePreview = false }: { acceptancePreview?: boolean } = {}) {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('upload');
  const [creationMode, setCreationMode] = useState<CreationMode>('generate');
  const [sourceAssets, setSourceAssets] = useState<CreativeSourceAsset[]>([]);
  const [context, setContext] = useState('');
  const [variationCount, setVariationCount] = useState(4);
  const [peoplePercent, setPeoplePercent] = useState(50);
  const [useReferenceLibrary, setUseReferenceLibrary] = useState(true);
  const [placement, setPlacement] = useState<CreativePlacement>('SQUARE_1_1');
  const [omitTestLogo, setOmitTestLogo] = useState(false);
  const [uploadedCreatives, setCreatives] = useState<GeneratedCreative[]>([]);
  const [generationError, setGenerationError] = useState('');
  const [handoffGenerate, setHandoffGenerate] = useState(false);
  const handoffConsumedRef = useRef(false);
  const handoffGenerationStartedRef = useRef(false);
  const portfolio = useCreativePortfolio();
  const videoReview = useVideoReviewDraft(portfolio.observeAccess);
  const videos = useSavedVideoSources(sourceAssets, setSourceAssets, videoReview, portfolio.observeAccess);
  const generating = portfolio.running || portfolio.loading;
  const savedPortfolio = portfolio.response?.job;
  useEffect(() => {
    if (savedPortfolio?.useReferenceLibrary !== undefined) setUseReferenceLibrary(savedPortfolio.useReferenceLibrary);
    if (savedPortfolio?.peoplePercent !== undefined) {
      setPeoplePercent(savedPortfolio.peoplePercent);
      setVariationCount(savedPortfolio.requestedCount);
    }
  }, [savedPortfolio?.id, savedPortfolio?.peoplePercent, savedPortfolio?.requestedCount, savedPortfolio?.useReferenceLibrary]);
  const creatives = creationMode === 'generate' ? portfolio.response?.creatives ?? [] : uploadedCreatives;
  const generationComplete = !savedPortfolio || savedPortfolio.slots.every(slot => slot.status === 'SAVED');
  const generationFailures = Object.fromEntries((savedPortfolio?.slots ?? [])
    .filter(slot => ['RETRY_REQUIRED', 'BLOCKED'].includes(slot.status))
    .map(slot => [slot.index, slot.error || 'Could not be completed.']));
  const displayGenerationError = creationMode === 'generate' ? portfolio.error || generationError : generationError;

  const ready = Boolean(context.trim()) && !portfolio.authRequired && !videos.pending && !videos.error && videoReview.canGenerate();

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
    setPeoplePercent(draft.peoplePercent ?? 50);
    setUseReferenceLibrary(draft.useReferenceLibrary ?? true);
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
    if (role !== 'TRA_VIDEO') { videos.forget(mediaId); void videoReview.removeVideo(mediaId); }
    setSourceAssets((current) =>
      current.map((source) =>
        source.media.id === mediaId ? { ...source, role } : source
      )
    );
    setCreatives([]);
    setGenerationError('');
  };

  const handleSourceRemoved = (mediaId: string) => {
    videos.forget(mediaId);
    void videoReview.removeVideo(mediaId);
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

  const switchWorkspaceSection = (nextSection: WorkspaceSection) => {
    if (nextSection === activeSection) return;
    if (activeSection === 'upload') portfolio.stop();
    setActiveSection(nextSection);
    if (nextSection === 'upload') void portfolio.restoreSaved();
  };

  const generate = async () => {
    if (!ready || generating || !videoReview.canGenerate()) return;
    setGenerationError('');
    try {
      const previewOmitBrandLogo = acceptancePreview && omitTestLogo;
      const brand = readStoredBrandGuidance({ omitLogo: previewOmitBrandLogo });
      const companyProfile = readStoredRuntimeCompanyProfile();
      const reviewReference = videoReview.generationReference();
      await portfolio.start({
        companySourceScope: { version: 1, referenceIds: readSelectedCompanyReferenceIds() },
        ...(reviewReference ? { videoReview: reviewReference } : {}),
        ...(previewOmitBrandLogo ? { previewOmitBrandLogo: true } : {}),
        sourceAssets: sourceAssets.map(source => ({ mediaId: source.media.id, role: source.role })),
        ...(brand.logo ? { brandLogoMediaId: brand.logo.mediaId } : {}),
        ...(brand.colors.length ? { brandColors: brand.colors } : {}),
        ...(brand.fontGuidance.length ? { brandFontNames: brand.fontGuidance } : {}),
        ...(companyProfile ? { companyProfile } : {}),
        context: context.trim(), variationCount, peoplePercent, useReferenceLibrary, placement,
      });
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : 'Creative generation failed.');
    }
  };

  useEffect(() => {
    if (
      !handoffGenerate ||
      !ready ||
      !context.trim() ||
      generating ||
      handoffGenerationStartedRef.current
    ) {
      return;
    }

    handoffGenerationStartedRef.current = true;
    setHandoffGenerate(false);
    void generate();
  }, [handoffGenerate, context, sourceAssets, variationCount, peoplePercent, useReferenceLibrary, ready, generating]);

  return (
    <main className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <div className="workspace-brand-mark">TM</div>
        </div>

        <nav className="workspace-nav" aria-label="Creative workspace">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`workspace-nav-item ${
                activeSection === item.id ? 'workspace-nav-item-active' : ''
              }`}
              onClick={() => switchWorkspaceSection(item.id)}
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
          Company workspace
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

                {creationMode === 'generate' && acceptancePreview ? <div className="panel">
                  <p>Generate may run paid source preparation, planning, and image generation using your connected API account. Operation quotas do not guarantee a dollar ceiling.</p>
                  <label><input type="checkbox" checked={omitTestLogo} disabled={generating}
                    onChange={event => setOmitTestLogo(event.target.checked)} /> Run this Preview test without a logo</label>
                  {omitTestLogo ? <p>The images will be requested without logos. Logo fidelity is not being evaluated.</p> : null}
                </div> : null}
                {creationMode === 'generate' ? (
                  <CreativeComposer
                    value={context}
                    onChange={setContext}
                    onUploadStart={handleUploadStart}
                    onUploaded={handleUploaded}
                    sourceAssets={sourceAssets}
                    onSourceRoleChange={handleSourceRoleChange}
                    onSourceRemoved={handleSourceRemoved}
                    useReferenceLibrary={useReferenceLibrary}
                    onReferenceLibraryChange={setUseReferenceLibrary}
                    peoplePercent={peoplePercent}
                    onPeoplePercentChange={setPeoplePercent}
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

                {creationMode === 'generate' ? <>
                  {videos.pending ? <p role="status">Restoring saved videos…</p> : null}
                  {videos.error ? <div role="alert"><p>{videos.error}</p>
                    <button type="button" disabled={videos.pending || generating} onClick={videos.reload}>Reload saved videos</button>
                    <button type="button" disabled={videos.pending || generating} onClick={() => void videos.clearUnavailable()}>Remove unavailable videos</button>
                  </div> : null}
                  {videoReview.profileChanged() ? <div role="alert"><p>Company Profile changed. Saved selected wording is preserved. Use the current Profile and reselect its statements before generating.</p>
                    <button type="button" disabled={generating || videoReview.state.pending > 0} onClick={() => void videoReview.useCurrentProfile()}>Use current Company Profile</button>
                  </div> : null}
                  <SavedVideoReviewSummary draft={videoReview} />
                  <VideoReviewPanel videos={sourceAssets.filter(source => source.role === 'TRA_VIDEO').map(source => ({ id: source.media.id, name: source.media.originalName }))} draft={videoReview} disabled={generating} authRequired={portfolio.authRequired} observeAccess={portfolio.observeAccess} />
                  <PortfolioProgressPanel portfolio={portfolio} />
                </> : null}
                {videoReview.state.error || videoReview.state.saved?.issues.length || (displayGenerationError && videoReview.state.saved) ? (
                  <div role={videoReview.state.error || videoReview.state.saved?.issues.length ? 'alert' : undefined} className="error-message">
                    {videoReview.state.error || videoReview.state.saved?.issues.length ? <p>{videoReview.state.error || videoReview.state.saved?.issues.map(issue => issue.message).join(' ')}</p> : null}
                    <button type="button" disabled={videoReview.state.pending > 0} onClick={() => void videoReview.reload()}>Reload saved review</button>
                    {videoReview.state.saved?.issues.length ? <button type="button" disabled={generating || videoReview.state.pending > 0 || Boolean(videoReview.state.error)}
                      onClick={() => void videoReview.clearUnavailable()}>Remove unavailable material</button> : null}
                  </div>
                ) : null}
                {displayGenerationError ? (
                  <p role="alert" className="error-message generation-error">{displayGenerationError}</p>
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
              renderFailureDetails={creationMode === 'generate' && savedPortfolio ? index => {
                const slot = savedPortfolio.slots.find(slot => slot.index === index);
                return slot && ['RETRY_REQUIRED', 'BLOCKED'].includes(slot.status) && slot.videoSelection?.version === 2 && slot.videoSelection.providerPortrait
                  ? <PortfolioPortraitDiagnosticAction key={`${savedPortfolio.id}:${index}`} id={savedPortfolio.id} slotIndex={index}
                    disabled={generating || portfolio.authRequired || Boolean(savedPortfolio.lease)} observeAccess={portfolio.observeAccess} onStateChanged={()=>void portfolio.restoreSaved()} /> : null;
              } : undefined}
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
