'use client';

import { useEffect, useRef, useState } from 'react';
import type { GenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { createPortfolioSubmitter, PortfolioSignInRequiredError, requestPortfolio, runPortfolio, type PortfolioResponse } from '@/lib/creatives/portfolio-client';
import { workspaceSignInUrl } from '@/lib/auth/return-path';
import type { WorkspaceAccessObserver } from '@/lib/auth/workspace-access-client';

const LAST_PORTFOLIO = 'tax-marketing-studio-creative-portfolio-v1';
export function useCreativePortfolio() {
  const [response, setResponse] = useState<PortfolioResponse | null>(null);
  const [running, setRunning] = useState(false), [stopped, setStopped] = useState(false), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [authRequired, setAuthRequired] = useState(false);
  const current = useRef<PortfolioResponse | null>(null), busy = useRef(false), stopRequested = useRef(false), mounted = useRef(true);
  const advancing = useRef(false), refreshPending = useRef(false);
  const accessFailures = useRef(new Set<string>());
  const observeAccess = useRef<WorkspaceAccessObserver>((resource, status) => {
    if (status === 401) accessFailures.current.add(resource);
    else if (status >= 200 && status < 300) accessFailures.current.delete(resource);
    const denied = accessFailures.current.size > 0;
    if (mounted.current) setAuthRequired(denied);
    if (denied && advancing.current) { stopRequested.current = true; if (mounted.current) setStopped(true); }
  }).current;
  const submit = useRef(createPortfolioSubmitter(undefined, observeAccess));
  useEffect(() => {
    mounted.current = true; stopRequested.current = false;
    const pause = () => { if (advancing.current) { stopRequested.current = true; setStopped(true); } };
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (busy.current) { if (advancing.current) { pause(); refreshPending.current = true; } return; }
      void restoreSaved(); // Status only. Returning never grants paid continuation.
    };
    const visibility = () => { if (document.visibilityState === 'hidden') pause(); else refresh(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pause); window.addEventListener('focus', refresh); window.addEventListener('pageshow', refresh);
    return () => {
      mounted.current = false; stopRequested.current = true;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pause); window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh);
    };
  }, []);
  const update = (value: PortfolioResponse) => {
    current.current = value;
    try { window.localStorage.setItem(LAST_PORTFOLIO, value.job.id); } catch { /* URL remains available when storage is disabled. */ }
    if (!mounted.current) return;
    const url = new URL(window.location.href); url.searchParams.set('portfolio', value.job.id);
    window.history.replaceState(null, '', url);
    setResponse(value);
  };
  const execute = async (task: () => Promise<PortfolioResponse>, advance: boolean) => {
    if (busy.current || (advance && accessFailures.current.size)) return;
    busy.current = true; advancing.current = advance; stopRequested.current = false;
    setStopped(false); setRunning(advance); setLoading(!advance); setError('');
    try {
      const value = await task(); update(value);
      if (value.error) throw new Error(value.error);
      if (advance) await runPortfolio(value, update, () => stopRequested.current || !mounted.current || document.visibilityState === 'hidden', undefined, observeAccess);
    } catch (failure) {
      if (mounted.current) {
        if (failure instanceof PortfolioSignInRequiredError) observeAccess('portfolio', 401);
        setError(failure instanceof Error ? failure.message : 'Portfolio work failed. Reload saved progress.');
      }
    } finally {
      busy.current = false; advancing.current = false;
      if (mounted.current) {
        setRunning(false); setLoading(false);
        if (refreshPending.current && document.visibilityState === 'visible') { refreshPending.current = false; void restoreSaved(); }
      }
    }
  };
  const start = (request: GenerateCreativeRequest) => execute(() => submit.current(request), true);
  const initializeApprovedPreview = () => {
    if (accessFailures.current.size) return;
    const source = current.current;
    if (source?.previewInitializationAvailable) return execute(() => requestPortfolio({
      action: 'initialize-approved-preview', sourcePortfolioId: source.job.id,
    }, observeAccess), false);
  };
  const recoverBoundCaseCrop = (slotIndex: number) => {
    if (accessFailures.current.size || current.current?.boundCaseCropRecoverySlot !== slotIndex) return;
    const id = current.current.job.id;
    return execute(() => requestPortfolio({ action: 'recover-bound-case-crop', id, slotIndex }, observeAccess), false);
  };
  const revisedCropStep = (action:'assess-bound-case-crop'|'generate-bound-case-crop',slotIndex:number) => {
    if(accessFailures.current.size || !current.current) return;
    return execute(()=>requestPortfolio({action,id:current.current!.job.id,slotIndex,approved:true},observeAccess),false);
  };
  const resume = () => {
    const id = current.current?.job.id;
    if (id) return execute(async () => {
      const { preflightReady: _ready, ...loaded } = await requestPortfolio({ action: 'load', id }, observeAccess);
      return loaded;
    }, true);
  };
  const retry = (slotIndex: number | null) => {
    const id = current.current?.job.id;
    if (id) return execute(() => requestPortfolio({ action: 'retry', id, slotIndex }, observeAccess), true);
  };
  const restoreSaved = () => {
    if (busy.current) { if (advancing.current) refreshPending.current = true; return; }
    let id = new URL(window.location.href).searchParams.get('portfolio');
    try { id ||= window.localStorage.getItem(LAST_PORTFOLIO); } catch { /* Query links also support reopening. */ }
    if (id) return execute(() => requestPortfolio({ action: 'load', id: id! }, observeAccess), false);
  };
  const stop = () => { stopRequested.current = true; setStopped(true); };
  const signInUrl = workspaceSignInUrl(typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search);
  return { response, running, loading, stopped, authRequired, signInUrl, error, start, initializeApprovedPreview, recoverBoundCaseCrop, resume, retry, restoreSaved, stop, observeAccess, revisedCropStep };
}
