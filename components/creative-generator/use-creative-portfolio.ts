'use client';

import { useEffect, useRef, useState } from 'react';
import type { GenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { requestPortfolio, runPortfolio, type PortfolioResponse } from '@/lib/creatives/portfolio-client';

const LAST_PORTFOLIO = 'tra-creative-portfolio-v1';
export function useCreativePortfolio() {
  const [response, setResponse] = useState<PortfolioResponse | null>(null);
  const [running, setRunning] = useState(false), [stopped, setStopped] = useState(false), [error, setError] = useState('');
  const current = useRef<PortfolioResponse | null>(null), busy = useRef(false), stopRequested = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; stopRequested.current = false; return () => { mounted.current = false; stopRequested.current = true; }; }, []);
  const update = (value: PortfolioResponse) => {
    current.current = value;
    try { window.localStorage.setItem(LAST_PORTFOLIO, value.job.id); } catch { /* URL remains available when storage is disabled. */ }
    if (!mounted.current) return;
    const url = new URL(window.location.href); url.searchParams.set('portfolio', value.job.id);
    window.history.replaceState(null, '', url);
    setResponse(value);
  };
  const execute = async (task: () => Promise<PortfolioResponse>, advance: boolean) => {
    if (busy.current) return;
    busy.current = true; stopRequested.current = false; setStopped(false); setRunning(true); setError('');
    try {
      const value = await task(); update(value);
      if (value.error) throw new Error(value.error);
      if (advance) await runPortfolio(value, update, () => stopRequested.current || !mounted.current);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Portfolio work failed. Reload saved progress.');
    } finally {
      busy.current = false;
      if (mounted.current) setRunning(false);
    }
  };
  const start = (request: GenerateCreativeRequest) => {
    const submissionId = crypto.randomUUID();
    return execute(() => requestPortfolio({ action: 'create', request, submissionId }), true);
  };
  const resume = () => {
    const id = current.current?.job.id;
    if (id) return execute(() => requestPortfolio({ action: 'load', id }), true);
  };
  const retry = (slotIndex: number | null) => {
    const id = current.current?.job.id;
    if (id) return execute(() => requestPortfolio({ action: 'retry', id, slotIndex }), true);
  };
  const restoreSaved = () => {
    let id = new URL(window.location.href).searchParams.get('portfolio');
    try { id ||= window.localStorage.getItem(LAST_PORTFOLIO); } catch { /* Query links also support reopening. */ }
    if (id) return execute(() => requestPortfolio({ action: 'load', id: id! }), false);
  };
  const stop = () => { stopRequested.current = true; setStopped(true); };
  return { response, running, stopped, error, start, resume, retry, restoreSaved, stop };
}
