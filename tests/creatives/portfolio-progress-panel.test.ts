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
  loading = false,
  authRequired = false,
  stopped = false,
  planningError = null,
  planReady = false,
  videoPreparation,
  preflightReady = false,
  previewOmitBrandLogo = false,
  previewPreparationApproved = false,
  previewPreparationResume = false,
  previewInitializationAvailable = false,
  previewAcceptanceError,
  boundCaseCropRecoverySlot,
}: {
  count?: number;
  statuses?: Array<'PENDING' | 'SAVED' | 'RETRY_REQUIRED' | 'BLOCKED'>;
  running?: boolean;
  loading?: boolean;
  authRequired?: boolean;
  stopped?: boolean;
  planningError?: string | null;
  planReady?: boolean;
  videoPreparation?: PortfolioProgress['videoPreparation'];
  preflightReady?: boolean;
  previewOmitBrandLogo?: boolean;
  previewPreparationApproved?: boolean;
  previewPreparationResume?: boolean;
  previewInitializationAvailable?: boolean;
  previewAcceptanceError?: string;
  boundCaseCropRecoverySlot?: number;
} = {}) => {
  const base = portfolioProgress(newCreativePortfolio(portfolioRequest(count)));
  const job = {
    ...base,
    planReady,
    planningPhase: planReady ? 'READY_TO_RENDER' as const : base.planningPhase,
    planningError,
    ...(previewAcceptanceError ? { previewAcceptanceError } : {}),
    ...(previewPreparationResume ? { previewPreparationResume: true } : {}),
    ...(videoPreparation ? { videoPreparation } : {}),
    ...(statuses ? {
      slots: base.slots.map((slot, index) => ({
        ...slot,
        status: statuses[index] ?? 'PENDING',
        ...(['RETRY_REQUIRED', 'BLOCKED'].includes(statuses[index] ?? 'PENDING')
          ? { error: (statuses[index] ?? 'PENDING') === 'BLOCKED'
              ? 'Create a new portfolio with a smaller video pool; saved creatives remain available.' : 'Render failed.' } : {}),
      })),
    } : {}),
  };
  const resume = vi.fn();
  const retry = vi.fn();
  const portfolio = {
    response: { job, creatives: [], ...(boundCaseCropRecoverySlot !== undefined ? { boundCaseCropRecoverySlot } : {}), ...(preflightReady ? { preflightReady: true } : {}),
      ...(previewOmitBrandLogo ? { previewOmitBrandLogo: true } : {}),
      ...(previewPreparationApproved ? { previewPreparationApproved: true } : {}),
      ...(previewInitializationAvailable ? { previewInitializationAvailable: true } : {}) },
    running,
    loading,
    authRequired,
    signInUrl: '/sign-in?redirect_url=%2F%3Fportfolio%3Dsaved%26review%3Dreview',
    stopped,
    error: '',
    start: vi.fn(),
    initializeApprovedPreview: vi.fn(),
    resume,
    retry,
    restoreSaved: vi.fn(),
    stop: vi.fn(),
  } as unknown as PortfolioHook;

  return { html: renderToStaticMarkup(createElement(PortfolioProgressPanel, { portfolio })), resume, retry };
};

describe('portfolio progress panel', () => {
  it('distinguishes a read-only refresh and an idle saved plan from active generation', () => {
    const idle = renderPanel({ count: 2, planReady: true }).html;
    expect(idle).toContain('Generation is paused. Resume to continue the saved plan.');
    expect(idle).toContain('returning does not restart generation');
    expect(idle).toContain('Reload saved progress');
    const loading = renderPanel({ count: 2, planReady: true, loading: true }).html;
    expect(loading).toContain('Loading saved progress. This check does not start generation.');
    expect(loading).not.toContain('Generating creatives.');
    expect(loading).toMatch(/disabled=""[^>]*>Resume generation/);
  });
  it('offers saved-context sign-in recovery and prevents paid actions while signed out', () => {
    const html = renderPanel({ count: 2, planReady: true, authRequired: true }).html;
    expect(html).toContain('Sign in to restore saved progress');
    expect(html).toContain('Sign in required. Saved progress is preserved. Reload after signing in.');
    expect(html).not.toContain('Generation is paused. Resume to continue the saved plan.');
    expect(html).toContain('portfolio%3Dsaved%26review%3Dreview');
    expect(html).toMatch(/disabled=""[^>]*>Resume generation/);
  });
  it('shows an explicit nonpaid initialization button on the eligible stopped run and disables it while busy', () => {
    const args = { count: 2, planningError: 'Prior assessment failed', previewAcceptanceError: 'Old run stopped', previewInitializationAvailable: true };
    const { html } = renderPanel(args);
    expect(html).toContain('Prepare approved reassessment'); expect(html).toContain('This starts no AI calls');
    expect(html).toContain('Old run stopped'); expect(html).not.toContain('Retry planning'); expect(html).not.toContain('Resume generation');
    const busy = renderPanel({ ...args, running: true }).html;
    expect(busy).toMatch(/disabled=""[^>]*>Prepare approved reassessment/);
    expect(busy).toContain('No AI calls are started');
    expect(renderPanel().html).not.toContain('Prepare approved reassessment');
  });
  it.each(['RETRY_REQUIRED', 'SAVED'] as const)('retains the approved stop after slot recovery=%s and hides Resume/Retry', status => {
    const { html } = renderPanel({ count: 2, planReady: true, previewPreparationApproved: true,
      statuses: [status, 'PENDING'], previewAcceptanceError: 'Approved test stopped after an unknown image outcome.' });
    expect(html).toContain('unknown image outcome'); expect(html).toContain('role="alert"');
    expect(html).not.toContain('Resume generation'); expect(html).not.toContain('Retry creative');
  });
  it('offers Resume for the new approved run, labels the estimated budget and hides Retry', () => {
    const { html } = renderPanel({ count: 2,
      previewPreparationApproved: true, previewOmitBrandLogo: true });
    expect(html).toContain('two new selected-frame assessments once each');
    expect(html).toContain('Both frames must pass before planning');
    expect(html).toContain('estimate, with no guaranteed dollar ceiling');
    expect(html).toContain('Resume generation'); expect(html).not.toContain('Retry planning');
    const checkpoint = renderPanel({ count: 2, previewPreparationApproved: true, preflightReady: true }).html;
    expect(checkpoint).toContain('Approved preparation is complete. Planning and images have not started.');
    expect(checkpoint).not.toContain('Cached-input preflight passed');
    const failure = renderPanel({ count: 2, previewPreparationApproved: true, planningError: 'Provider outcome is unknown.' }).html;
    expect(failure).toContain('Provider outcome is unknown.'); expect(failure).toContain('role="alert"');
    expect(failure).not.toContain('Resume generation'); expect(failure).not.toContain('Retry planning');
  });
  it('marks the frozen no-logo scope separately from cached preflight or image completion', () => {
    const { html } = renderPanel({ count: 2, preflightReady: true, previewOmitBrandLogo: true });
    expect(html).toContain('Logo omitted for this Preview test. Logo fidelity is not being evaluated.');
    expect(html).toContain('No paid planning or images have started');
    expect(html).toContain('Resume generation');
  });
  it('shows the nonpaid cached checkpoint and bounded Resume scope', () => {
    const { html } = renderPanel({ count: 2, preflightReady: true });
    expect(html).toContain('Cached-input preflight passed');
    expect(html).toContain('No paid planning or images have started');
    expect(html).toContain('one initial planner, one audit and two Sunburst images');
    expect(html).toContain('Resume generation');
  });
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

  it('treats terminal video preparation failure as attention, not resumable planning', () => {
    const html = renderPanel({
      videoPreparation: { total: 1, completed: 0, phase: 'FAILED', busy: false },
    }).html;
    expect(html).toContain('Generation needs attention.');
    expect(html).toContain('Preparation failed');
    expect(html).not.toContain('Ready to resume planning');
    expect(html).not.toContain('Resume generation');
  });

  it('shows completion after Stop when the final in-flight creative saves', () => {
    const html = renderPanel({
      count: 2,
      planReady: true,
      stopped: true,
      statuses: ['SAVED', 'SAVED'],
    }).html;
    expect(html).toContain('Generation complete.');
    expect(html).not.toContain('Generation stopped. Saved progress is preserved.');
    expect(html).not.toContain('Resume generation');
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

  it('shows durable recovery guidance for blocked work without Retry or false completion', () => {
    const { html } = renderPanel({ count: 3, planReady: true, statuses: ['SAVED', 'BLOCKED', 'PENDING'] });
    expect(html).toContain('<strong>1 / 3</strong> creatives saved');
    expect(html).toContain('Create a new portfolio with a smaller video pool; saved creatives remain available.');
    expect(html).not.toContain('Retry creative 2');
    expect(html).not.toContain('Generation complete.');
    expect(html).toContain('Resume generation');
  });
});

it('offers only the server-advertised non-paid recovery and preserves authentication/loading guards', () => {
  for (const guard of [{}, { authRequired: true }, { loading: true }, { running: true }]) {
    const { html: markup } = renderPanel({ count: 2, statuses: ['SAVED', 'BLOCKED'], planReady: true, boundCaseCropRecoverySlot: 2, ...guard });
    expect(markup).toContain('Prepare clean-frame recovery for Creative 2');
    expect(markup).toContain('starts no AI calls');
    const button = markup.match(/<button[^>]*>Prepare clean-frame recovery for Creative 2<\/button>/)?.[0];
    expect(button).toBeDefined(); expect(button?.includes('disabled')).toBe(Object.keys(guard).length > 0);
  }
  expect(renderPanel({ count: 2, statuses: ['SAVED', 'BLOCKED'], planReady: true }).html)
    .not.toContain('Prepare clean-frame recovery');
});
