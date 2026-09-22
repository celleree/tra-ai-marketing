'use client';

import { portfolioCanAdvance } from '@/lib/creatives/portfolio-client';
import type { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
import styles from './portfolio-progress-panel.module.css';

const videoLabel = {
  PREPARING: 'Preparing source', TRANSCRIBING: 'Transcribing', OBSERVING: 'Analyzing scenes', FINALIZING: 'Saving library',
  COMPLETE: 'Ready', FAILED: 'Preparation failed', RETRY_REQUIRED: 'Retry required',
} as const;
const activeVideoPhases = new Set(['PREPARING', 'TRANSCRIBING', 'OBSERVING', 'FINALIZING']);

export function PortfolioProgressPanel({ portfolio }: { portfolio: ReturnType<typeof useCreativePortfolio> }) {
  const job = portfolio.response?.job;
  if (!job) return null;

  const savedCount = job.slots.filter(slot => slot.status === 'SAVED').length;
  const failed = job.slots.filter(slot => slot.status === 'RETRY_REQUIRED');
  const blocked = job.slots.filter(slot => slot.status === 'BLOCKED');
  const complete = savedCount === job.requestedCount;
  const videoFailed = job.videoPreparation?.phase === 'FAILED';
  const hasFailure = Boolean(job.planningError) || failed.length > 0 || blocked.length > 0 || videoFailed;
  const retryFailure = Boolean(job.planningError) || failed.length > 0;
  const preparingVideo = Boolean(job.videoPreparation && activeVideoPhases.has(job.videoPreparation.phase));

  const status = !portfolio.running && complete
    ? 'Generation complete.'
    : portfolio.stopped
      ? portfolio.running ? 'Stopping after current work…' : 'Generation stopped. Saved progress is preserved.'
      : portfolio.running
        ? preparingVideo ? 'Preparing video sources…'
          : job.planReady ? 'Generating creatives…' : `Planning ${job.requestedCount} creatives…`
        : hasFailure ? 'Generation needs attention.'
          : job.planReady ? 'Ready to resume generation.' : `Ready to resume planning ${job.requestedCount} creatives.`;

  return <section className={`panel ${styles.panel}`} aria-label="Saved portfolio progress">
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
      {portfolio.running ? <button type="button" className="button button-secondary" disabled={portfolio.stopped} onClick={portfolio.stop}>
        {portfolio.stopped ? 'Stopping generation…' : 'Stop generation'}
      </button> : portfolioCanAdvance(job) ? <button type="button" className="button button-primary" onClick={() => void portfolio.resume()}>Resume generation</button> : null}
      <a href={`?portfolio=${job.id}`} target="_blank" rel="noreferrer">Open saved portfolio</a>
    </div>

    {retryFailure ? <div className={styles.failures} aria-live="polite">
      <p>Retrying failed work may make another paid call.</p>
      {job.planningError ? <p>{job.planningError} <button type="button" className="button button-secondary" disabled={portfolio.running || Boolean(job.lease)}
        onClick={() => void portfolio.retry(null)}>Retry planning</button></p> : null}
      {failed.map(slot => <p key={slot.creativeId}>Creative {slot.index}: {slot.error || 'Could not be completed.'}{' '}
        <button type="button" className="button button-secondary" disabled={portfolio.running || Boolean(job.lease)}
          onClick={() => void portfolio.retry(slot.index)}>Retry creative {slot.index}</button></p>)}
    </div> : null}
    {blocked.length ? <div className={styles.failures} aria-live="polite">
      {blocked.map(slot => <p key={slot.creativeId}>Creative {slot.index}: {slot.error}</p>)}
    </div> : null}
  </section>;
}
