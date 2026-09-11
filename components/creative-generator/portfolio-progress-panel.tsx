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

export function PortfolioProgressPanel({ portfolio }: { portfolio: ReturnType<typeof useCreativePortfolio> }) {
  const job = portfolio.response?.job;
  if (!job) return null;
  const failed = job.slots.filter(slot => slot.status === 'RETRY_REQUIRED');
  return <section className={`panel ${styles.panel}`} aria-label="Saved portfolio progress">
    <p aria-live="polite"><strong>{job.slots.filter(slot => slot.status === 'SAVED').length} of {job.requestedCount} creatives saved</strong>
      {portfolio.running ? ` · ${planningLabel[job.planningPhase]}` : ''}</p>
    <p className="muted">Resume uses this portfolio’s saved brief and sources.</p>
    <div className={styles.actions}>
      {portfolio.running ? <button type="button" className="button button-secondary" disabled={portfolio.pausing} onClick={portfolio.pause}>
        {portfolio.pausing ? 'Pausing after current work…' : 'Pause after current work'}
      </button> : portfolioCanAdvance(job) ? <button type="button" className="button button-primary" onClick={() => void portfolio.resume()}>Resume portfolio</button> : null}
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
