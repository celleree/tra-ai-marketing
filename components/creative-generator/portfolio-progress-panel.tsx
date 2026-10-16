'use client';

import { useState } from 'react';
import { portfolioPauseLabel } from '@/lib/creatives/portfolio-continuation';
import { peopleMix } from '@/lib/creatives/people-mix';
import { PortfolioCaseAmendment } from './portfolio-case-amendment';

import { portfolioCanAdvance } from '@/lib/creatives/portfolio-client';
import type { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
import styles from './portfolio-progress-panel.module.css';

const videoLabel = {
  PREPARING: 'Preparing source', TRANSCRIBING: 'Transcribing', OBSERVING: 'Analyzing scenes', FINALIZING: 'Saving library',
  COMPLETE: 'Ready', FAILED: 'Preparation failed', RETRY_REQUIRED: 'Retry required',
} as const;
const activeVideoPhases = new Set(['PREPARING', 'TRANSCRIBING', 'OBSERVING', 'FINALIZING']);

export function PortfolioProgressPanel({ portfolio, canAdvance = () => true }: { portfolio: ReturnType<typeof useCreativePortfolio>; canAdvance?: () => boolean }) {
  const [caseEditorOpen, setCaseEditorOpen] = useState(false);
  const job = portfolio.response?.job;
  const signInNotice = portfolio.authRequired ? <p role="alert">Generation is paused. Sign in to restore the same saved portfolio.
    {' '}<a href={portfolio.signInUrl}>Sign in to restore saved progress</a></p> : null;
  if (!job) return signInNotice;

  const savedMix = job.peoplePercent === undefined ? null : peopleMix(job.requestedCount, job.peoplePercent);
  const savedCount = job.slots.filter(slot => slot.status === 'SAVED').length;
  const pending = job.slots.filter(slot => slot.status === 'PENDING');
  const failed = job.slots.filter(slot => slot.status === 'RETRY_REQUIRED');
  const ordinaryFailed = failed.filter(slot=>slot.videoSelection?.version!==2 || !slot.videoSelection.portraitCropRevision);
  const blocked = job.slots.filter(slot => slot.status === 'BLOCKED');
  const complete = savedCount === job.requestedCount;
  const revisedHold = job.slots.some(slot => slot.videoSelection?.version === 2 && slot.videoSelection.portraitCropRevision && !slot.videoSelection.portraitCropRevision.imageAuthorized);
  const videoFailed = job.videoPreparation?.phase === 'FAILED';
  const hasFailure = Boolean(job.previewAcceptanceError || (job.planningError && !job.previewPreparationResume)) || failed.length > 0 || blocked.length > 0 || videoFailed;
  const retryFailure = Boolean(job.planningError) || ordinaryFailed.length > 0;
  const preparingVideo = Boolean(job.videoPreparation && activeVideoPhases.has(job.videoPreparation.phase));
  const initializationAvailable = portfolio.response?.previewInitializationAvailable === true;
  const boundedPreview = portfolio.response?.previewPreparationApproved || initializationAvailable;
  const savedQuery = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  savedQuery.set('portfolio', job.id);

  const status = portfolio.authRequired ? 'Sign in required. Saved progress is preserved. Reload after signing in.'
    : portfolio.loading ? initializationAvailable ? 'Preparing the approved reassessment. No AI calls are started.' : 'Loading saved progress. This check does not start generation.'
    : portfolio.running && initializationAvailable ? 'Preparing the approved reassessment. No AI calls are started.' : !portfolio.running && complete
    ? 'Generation complete.'
    : portfolio.stopped
      ? portfolio.running ? 'Stopping after current work…' : 'Generation stopped. Saved progress is preserved.'
      : portfolio.running
        ? preparingVideo ? 'Preparing video sources…'
          : job.planReady ? 'Generating creatives…' : `Planning ${job.requestedCount} creatives…`
        : hasFailure ? 'Generation needs attention.'
          : job.lease ? 'A saved step is in progress. Reload saved progress to check its status.'
            : revisedHold ? 'Revised portrait is paused for its separate assessment and image approval.'
            : job.planReady ? 'Generation is paused. Resume to continue the saved plan.' : `Planning is paused. Resume to continue the saved ${job.requestedCount}-creative portfolio.`;

  return <section className={`panel ${styles.panel}`} aria-label="Saved portfolio progress">
    {signInNotice}
    {savedMix ? <p>Saved mix: {savedMix.withPeople} with people · {savedMix.withoutPeople} without people ({job.peoplePercent}%).</p> : null}
    {job.useReferenceLibrary === undefined ? null : <p>Saved reference library: {job.useReferenceLibrary ? 'On' : 'Off'}.</p>}
    {!complete ? <p>Leaving this page pauses continuation after the current step. Saved progress is preserved; returning does not restart generation.</p> : null}
    {!complete && !portfolio.running && !portfolio.loading ? <p role="status">{portfolio.pauseReason ? portfolioPauseLabel[portfolio.pauseReason] : 'The reason continuation paused is unknown in this browser.'} This explanation is local to this browser; the portfolio remains saved on the server.</p> : null}
    {job.planReady ? <p>{pending.length} pending · {failed.length} require Retry · {blocked.length} blocked. Resume continues all pending work, including prepared retries. Other failed slots require separate retry preparation; saved creatives are preserved.</p> : null}
    {!complete ? <p>Resume may make paid calls, including after retry preparation. The saved plan, mix and source choices are reused; no dollar ceiling is guaranteed.</p> : null}
    {initializationAvailable ? <p role="status">The stopped run is preserved. Prepare the approved reassessment with the same saved inputs and layout preparation. This starts no AI calls; use Resume separately for the two approved frame assessments.</p> : null}
    {portfolio.response?.previewPreparationApproved ? <p role="status">This saved Preview test reuses the saved layout preparation and permits two new selected-frame assessments once each. Both frames must pass before planning. The $1 budget is an estimate, with no guaranteed dollar ceiling. No retries, repair or fallback are authorized.</p> : null}
    {portfolio.response?.preflightReady ? <p role="status">{portfolio.response.previewPreparationApproved
      ? 'Approved preparation is complete. Planning and images have not started. Resume for one initial planner, one audit and at most two Sunburst images.'
      : 'Cached-input preflight passed. No paid planning or images have started. Resume only after approval for one initial planner, one audit and two Sunburst images. Uncached preparation, repair, retries and fallback are blocked in this Preview.'}</p> : null}
    {portfolio.response?.previewOmitBrandLogo ? <p role="status">Logo omitted for this Preview test. Logo fidelity is not being evaluated.</p> : null}
    <div className={styles.summary} aria-live="polite">
      <p className={styles.status}><strong>{status}</strong></p>
      <p className={styles.count}><strong>{savedCount} / {job.requestedCount}</strong> creatives saved</p>
      <progress
        className={styles.progress}
        value={savedCount}
        max={job.requestedCount}
        aria-label={`Creative generation progress: ${savedCount} of ${job.requestedCount} saved`}
        aria-valuemin={0}
        aria-valuemax={job.requestedCount}
        aria-valuenow={savedCount}
      />
    </div>

    {job.videoPreparation ? <p className={styles.videoStatus} aria-live="polite">
      <strong>Video preparation: {job.videoPreparation.completed} / {job.videoPreparation.total} ready</strong>
      {' · '}{job.videoPreparation.busy ? 'Current video step in progress' : videoLabel[job.videoPreparation.phase]}
    </p> : null}

    <div className={styles.actions}>
      {initializationAvailable ? <button type="button" className="button button-primary" disabled={portfolio.running || portfolio.loading || portfolio.authRequired || Boolean(job.lease)}
        onClick={() => { void portfolio.initializeApprovedPreview(); }}>Prepare approved reassessment</button> : portfolio.running ? <button type="button" className="button button-secondary" disabled={portfolio.stopped} onClick={portfolio.stop}>
        {portfolio.stopped ? 'Stopping generation…' : 'Stop generation'}
      </button> : portfolioCanAdvance(job, portfolio.response?.previewPreparationApproved) ? <button type="button" className="button button-primary" disabled={caseEditorOpen || portfolio.loading || portfolio.authRequired || !canAdvance()} onClick={() => { if (!caseEditorOpen && canAdvance()) void portfolio.resume(); }}>Resume generation</button> : null}
      {job.planReady && job.videoPreparation && !boundedPreview && !hasFailure && savedCount === 0
        && job.slots.every(slot => slot.status === 'PENDING' && !slot.videoSelection) ? <button type="button"
          disabled={caseEditorOpen || portfolio.running || portfolio.loading || portfolio.authRequired || Boolean(job.lease)}
          onClick={() => setCaseEditorOpen(true)}>Use selected video cases</button> : null}
      {portfolio.response?.boundCaseCropRecoverySlot !== undefined ? <button type="button" className="button button-secondary"
        disabled={caseEditorOpen || portfolio.running || portfolio.loading || portfolio.authRequired || Boolean(job.lease)}
        onClick={() => { void portfolio.recoverBoundCaseCrop(portfolio.response!.boundCaseCropRecoverySlot!); }}>
        Prepare clean-frame recovery for Creative {portfolio.response.boundCaseCropRecoverySlot}
      </button> : null}
      <button type="button" className="button button-secondary" disabled={portfolio.running || portfolio.loading} onClick={() => { void portfolio.restoreSaved(); }}>Reload saved progress</button>
      <a href={'?' + savedQuery.toString()} target="_blank" rel="noreferrer">Open saved portfolio</a>
    </div>

    {portfolio.response?.boundCaseCropRecoverySlot !== undefined || job.slots.some(slot => slot.boundCaseCropRecovery && slot.status !== 'SAVED')
      ? <p role="status">Preparing clean-frame recovery preserves saved creatives and starts no AI calls. Use Resume separately to assess the frame and continue the saved creative.</p> : null}

    {job.slots.filter(slot=>slot.videoSelection?.version===2 && slot.videoSelection.portraitCropRevision && slot.status!=='SAVED').map(slot=>{
      const v=slot.videoSelection as Extract<NonNullable<typeof slot.videoSelection>,{version:2}>;
      const busy=portfolio.running || portfolio.loading || portfolio.authRequired || Boolean(job.lease && job.lease.expiresAtMs > Date.now());
      return <div key={slot.creativeId}>
        <p>Creative {slot.index}: revised crop keeps the saved case/frame and prior evidence. Assessment and image generation are separate.</p>
        {!v.portraitCropRevision!.assessmentAttempted ? <>
          <p>Assess only: one standard GPT-6 Luna call, up to 2,048 output tokens; conservative published-rate bound $0.60 before tax. No retries or image generation.</p>
          <button type="button" disabled={busy} onClick={()=>void portfolio.revisedCropStep('assess-bound-case-crop',slot.index)}>Assess revised portrait for Creative {slot.index}</button>
        </> : v.providerPortrait?.verified && !v.portraitCropRevision!.imageAuthorized ? <>
          <p>Exact revised PNG passed. Image generation requires a separate approval; existing paid-attempt safeguards apply.</p>
          <button type="button" disabled={busy} onClick={()=>void portfolio.revisedCropStep('generate-bound-case-crop',slot.index)}>Generate Creative {slot.index} from verified crop</button>
        </> : <><p>No repeated assessment or image attempt is authorized. A saved completed assessment can be reconciled without another model call.</p>
          {!v.portraitCropRevision!.imageAuthorized ? <button type="button" disabled={busy} onClick={()=>void portfolio.revisedCropStep('assess-bound-case-crop',slot.index)}>Reconcile saved portrait assessment for Creative {slot.index}</button> : null}</>}
      </div>;
    })}
    {caseEditorOpen ? <PortfolioCaseAmendment key={job.id} id={job.id} observeAccess={portfolio.observeAccess}
      onClose={() => setCaseEditorOpen(false)} onSaved={() => { setCaseEditorOpen(false); void portfolio.restoreSaved(); }} /> : null}

    {retryFailure && !boundedPreview ? <div className={styles.failures} aria-live="polite">
      <p>Prepare retry resets only the selected failure and starts no paid work. Use Resume separately to continue pending work; it may make paid calls.</p>
      {job.planningError ? <p>{job.planningError} <button type="button" className="button button-secondary" disabled={portfolio.running || portfolio.loading || portfolio.authRequired || Boolean(job.lease) || !canAdvance()}
        onClick={() => { if (canAdvance()) void portfolio.retry(null); }}>Prepare planning retry</button></p> : null}
      {ordinaryFailed.map(slot => <p key={slot.creativeId}>Creative {slot.index}: Retry required. {slot.videoSelection && !slot.videoSelection.selection ? 'Frame selection failed before image generation. ' : ''}{slot.error || 'Could not be completed.'}{' '}
        <button type="button" className="button button-secondary" disabled={portfolio.running || portfolio.loading || portfolio.authRequired || Boolean(job.lease) || !canAdvance()}
          onClick={() => { if (canAdvance()) void portfolio.retry(slot.index); }}>Prepare retry for ad {slot.index}</button></p>)}
    </div> : null}
    {boundedPreview && hasFailure ? <div role="alert" className={styles.failures}>
      {job.previewAcceptanceError ? <p>{job.previewAcceptanceError}</p> : null}
      {job.planningError ? <p>{job.planningError}</p> : null}
      {ordinaryFailed.map(slot => <p key={slot.creativeId}>Creative {slot.index}: Retry required. {slot.videoSelection && !slot.videoSelection.selection ? 'Frame selection failed before image generation. ' : ''}{slot.error || 'Could not be completed.'}</p>)}
    </div> : null}
    {blocked.length ? <div className={styles.failures} aria-live="polite">
      {blocked.map(slot => <p key={slot.creativeId}>Creative {slot.index}: {slot.error}</p>)}
    </div> : null}
  </section>;
}
