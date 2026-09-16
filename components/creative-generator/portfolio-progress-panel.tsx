'use client';

import { portfolioCanAdvance } from '@/lib/creatives/portfolio-client';
import type { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
import styles from './portfolio-progress-panel.module.css';

const planningLabel = {
  INITIAL_PLAN: 'Initial plan…',
  DIVERSITY_AUDIT: 'Diversity audit…',
  TARGETED_REPAIR: 'Planning repair…',
  READY_TO_RENDER: 'Generating…',
} as const;
const videoLabel = {
  PREPARING: 'Preparing source', TRANSCRIBING: 'Transcribing', OBSERVING: 'Analyzing scenes', FINALIZING: 'Saving library',
  COMPLETE: 'Ready', FAILED: 'Preparation failed', RETRY_REQUIRED: 'Retry required',
} as const;

export function PortfolioProgressPanel({ portfolio }: { portfolio: ReturnType<typeof useCreativePortfolio> }) {
  const job = portfolio.response?.job;
  if (!job) return null;
  const failed = job.slots.filter(slot => slot.status === 'RETRY_REQUIRED');
  return <section className={`panel ${styles.panel}`} aria-label="Saved portfolio progress">
    <p aria-live="polite"><strong>{job.slots.filter(slot => slot.status === 'SAVED').length} of {job.requestedCount} creatives saved</strong>
      {portfolio.running ? ` · ${planningLabel[job.planningPhase]}` : ''}</p>
    {job.videoPreparation ? <p aria-live="polite"><strong>Video preparation: {job.videoPreparation.completed} of {job.videoPreparation.total} ready</strong>
      {' · '}{job.videoPreparation.busy ? 'Current video step in progress' : videoLabel[job.videoPreparation.phase]}</p> : null}
    <p className="muted">Resume uses this portfolio’s saved brief and sources.</p>
    <div className={styles.actions}>
      {portfolio.running ? <button type="button" className="button button-secondary" disabled={portfolio.stopped} onClick={portfolio.stop}>
        {portfolio.stopped ? 'Stopping generation…' : 'Stop generation'}
      </button> : portfolioCanAdvance(job) ? <button type="button" className="button button-primary" onClick={() => void portfolio.resume()}>Resume generation</button> : null}
      <a href={`?portfolio=${job.id}`} target="_blank" rel="noreferrer">Open saved portfolio</a>
    </div>
    {job.planningError || failed.length ? <div className={styles.failures}>
      <p>Retrying failed work may make another paid call.</p>
      {job.planningError ? <p>{job.planningError} <button type="button" className="button button-secondary" disabled={portfolio.running || Boolean(job.lease)}
        onClick={() => void portfolio.retry(null)}>Retry planning</button></p> : null}
      {failed.map(slot => <p key={slot.creativeId}>Creative {slot.index}: {slot.error || 'Could not be completed.'}{' '}
        <button type="button" className="button button-secondary" disabled={portfolio.running || Boolean(job.lease)}
          onClick={() => void portfolio.retry(slot.index)}>Retry creative {slot.index}</button></p>)}
    </div> : null}
  </section>;
}
