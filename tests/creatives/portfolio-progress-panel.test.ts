import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PortfolioProgressPanel } from '@/components/creative-generator/portfolio-progress-panel';
import type { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
import { portfolioProgress, type PortfolioProgress } from '@/lib/creatives/portfolio-progress';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { portfolioRequest } from '../fixtures/creative-portfolio';

type PortfolioHook = ReturnType<typeof useCreativePortfolio>;

const renderPanel = ({
  count = 12,
  statuses,
  running = false,
  stopped = false,
  planningError = null,
  planReady = false,
  videoPreparation,
}: {
  count?: number;
  statuses?: Array<'PENDING' | 'SAVED' | 'RETRY_REQUIRED'>;
  running?: boolean;
  stopped?: boolean;
  planningError?: string | null;
  planReady?: boolean;
  videoPreparation?: PortfolioProgress['videoPreparation'];
} = {}) => {
  const base = portfolioProgress(newCreativePortfolio(portfolioRequest(count)));
  const job = {
    ...base,
    planReady,
    planningPhase: planReady ? 'READY_TO_RENDER' as const : base.planningPhase,
    planningError,
    ...(videoPreparation ? { videoPreparation } : {}),
    ...(statuses ? {
      slots: base.slots.map((slot, index) => ({
        ...slot,
        status: statuses[index] ?? 'PENDING',
        ...((statuses[index] ?? 'PENDING') === 'RETRY_REQUIRED' ? { error: 'Render failed.' } : {}),
      })),
    } : {}),
  };
  const resume = vi.fn();
  const retry = vi.fn();
  const portfolio = {
    response: { job, creatives: [] },
    running,
    stopped,
    error: '',
    start: vi.fn(),
    resume,
    retry,
    restoreSaved: vi.fn(),
    stop: vi.fn(),
  } as unknown as PortfolioHook;

  return { html: renderToStaticMarkup(createElement(PortfolioProgressPanel, { portfolio })), resume, retry };
};

describe('portfolio progress panel', () => {
  it('shows requested planning count and zero saved progress without inventing a planning percentage', () => {
    const { html } = renderPanel({ count: 12, running: true });
    expect(html).toContain('Planning 12 creatives…');
    expect(html).toContain('<strong>0 / 12</strong> creatives saved');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="12"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('value="0"');
    expect(html).toContain('max="12"');
    expect(html).not.toMatch(/\d+%/);
    expect(html).toContain('Stop generation');
  });

  it('uses durable saved slots for partial and completed progress', () => {
    const partial = renderPanel({
      count: 4,
      planReady: true,
      running: true,
      statuses: ['SAVED', 'PENDING', 'SAVED', 'PENDING'],
    }).html;
    expect(partial).toContain('Generating creatives…');
    expect(partial).toContain('<strong>2 / 4</strong> creatives saved');
    expect(partial).toContain('aria-valuenow="2"');

    const complete = renderPanel({
      count: 4,
      planReady: true,
      statuses: ['SAVED', 'SAVED', 'SAVED', 'SAVED'],
    }).html;
    expect(complete).toContain('Generation complete.');
    expect(complete).toContain('<strong>4 / 4</strong> creatives saved');
    expect(complete).toContain('aria-valuenow="4"');
    expect(complete).not.toContain('Resume generation');
  });

  it('shows video preparation and stopped states clearly', () => {
    const preparing = renderPanel({
      running: true,
      videoPreparation: { total: 2, completed: 1, phase: 'TRANSCRIBING', busy: true },
    }).html;
    expect(preparing).toContain('Preparing video sources…');
    expect(preparing).toContain('Video preparation: 1 / 2 ready');
    expect(preparing).toContain('Current video step in progress');

    const stopped = renderPanel({ stopped: true }).html;
    expect(stopped).toContain('Generation stopped. Saved progress is preserved.');
    expect(stopped).toContain('Resume generation');
  });

  it('keeps Resume and paid-work Retry explicit after failures', () => {
    const { html } = renderPanel({
      count: 2,
      planReady: true,
      statuses: ['RETRY_REQUIRED', 'PENDING'],
    });
    expect(html).toContain('Generation needs attention.');
    expect(html).toContain('Retrying failed work may make another paid call.');
    expect(html).toContain('Retry creative 1');
    expect(html).toContain('Resume generation');
  });

  it('shows planning Retry explicitly and never auto-starts work merely by rendering reopened progress', () => {
    const { html, resume, retry } = renderPanel({ planningError: 'Previous planning was interrupted.' });
    expect(html).toContain('Generation needs attention.');
    expect(html).toContain('Retry planning');
    expect(html).not.toContain('Resume generation');
    expect(resume).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});
