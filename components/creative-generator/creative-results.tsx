'use client';

import { useEffect, useMemo, useState } from 'react';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import {
  META_CTA_TYPES,
  type MetaCtaType,
  type MetaPublishCreativeResult,
} from '@/lib/meta/types';
import styles from '@/components/creative-generator/creative-results.module.css';

interface CreativeResultsProps {
  creatives: GeneratedCreative[];
  generating?: boolean;
  requestedCount?: number;
}

interface MetaItem {
  id: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
}

type PublishState =
  | { status: 'uploading' }
  | ({ status: 'success' } & MetaPublishCreativeResult)
  | ({ status: 'failed' } & MetaPublishCreativeResult);

const readItems = async (response: Response) => {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Meta request failed.');
  }
  return (payload.items || []) as MetaItem[];
};

export function CreativeResults({
  creatives,
  generating = false,
  requestedCount = 0,
}: CreativeResultsProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sendOpen, setSendOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [metaError, setMetaError] = useState('');
  const [accounts, setAccounts] = useState<MetaItem[]>([]);
  const [campaigns, setCampaigns] = useState<MetaItem[]>([]);
  const [adSets, setAdSets] = useState<MetaItem[]>([]);
  const [pages, setPages] = useState<MetaItem[]>([]);
  const [adAccountId, setAdAccountId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [adSetId, setAdSetId] = useState('');
  const [pageId, setPageId] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [ctaType, setCtaType] = useState<MetaCtaType | ''>('LEARN_MORE');
  const [publishState, setPublishState] = useState<Record<string, PublishState>>({});

  useEffect(() => {
    setSelectedIds([]);
    setPublishState({});
  }, [creatives]);

  const selectedCreatives = useMemo(
    () => creatives.filter((creative) => selectedIds.includes(creative.id)),
    [creatives, selectedIds]
  );
  const allSelected = creatives.length > 0 && selectedIds.length === creatives.length;

  const toggleCreative = (creativeId: string) => {
    setSelectedIds((current) =>
      current.includes(creativeId)
        ? current.filter((id) => id !== creativeId)
        : [...current, creativeId]
    );
  };

  const openMetaDialog = async () => {
    if (!selectedCreatives.length) return;
    setSendOpen(true);
    setMetaError('');
    if (accounts.length && pages.length) return;

    setLoadingMeta(true);
    try {
      const [accountResponse, pageResponse] = await Promise.all([
        fetch('/api/meta/ad-accounts', { cache: 'no-store' }),
        fetch('/api/meta/pages', { cache: 'no-store' }),
      ]);
      const [nextAccounts, nextPages] = await Promise.all([
        readItems(accountResponse),
        readItems(pageResponse),
      ]);
      setAccounts(nextAccounts);
      setPages(nextPages);
      if (nextAccounts.length === 1) {
        setAdAccountId(nextAccounts[0].id);
      }
      if (nextPages.length === 1) {
        setPageId(nextPages[0].id);
      }
    } catch (error) {
      setMetaError(error instanceof Error ? error.message : 'Unable to load Meta setup.');
    } finally {
      setLoadingMeta(false);
    }
  };

  const chooseAccount = async (nextId: string) => {
    setAdAccountId(nextId);
    setCampaignId('');
    setAdSetId('');
    setCampaigns([]);
    setAdSets([]);
    setMetaError('');
    if (!nextId) return;

    setLoadingMeta(true);
    try {
      const response = await fetch(`/api/meta/campaigns?adAccountId=${encodeURIComponent(nextId)}`, {
        cache: 'no-store',
      });
      setCampaigns(await readItems(response));
    } catch (error) {
      setMetaError(error instanceof Error ? error.message : 'Unable to load campaigns.');
    } finally {
      setLoadingMeta(false);
    }
  };

  useEffect(() => {
    if (sendOpen && adAccountId && !campaigns.length && !campaignId) {
      void chooseAccount(adAccountId);
    }
    // chooseAccount is intentionally triggered only by dialog/account state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendOpen, adAccountId]);

  const chooseCampaign = async (nextId: string) => {
    setCampaignId(nextId);
    setAdSetId('');
    setAdSets([]);
    setMetaError('');
    if (!nextId) return;

    setLoadingMeta(true);
    try {
      const response = await fetch(`/api/meta/ad-sets?campaignId=${encodeURIComponent(nextId)}`, {
        cache: 'no-store',
      });
      setAdSets(await readItems(response));
    } catch (error) {
      setMetaError(error instanceof Error ? error.message : 'Unable to load ad sets.');
    } finally {
      setLoadingMeta(false);
    }
  };

  const publishToMeta = async () => {
    if (!adAccountId || !campaignId || !adSetId || !pageId || !destinationUrl.trim()) {
      setMetaError('Choose an ad account, campaign, ad set, Page, and destination URL.');
      return;
    }
    if (!selectedCreatives.length || publishing) return;

    setPublishing(true);
    setMetaError('');
    setPublishState((current) => {
      const next = { ...current };
      selectedCreatives.forEach((creative) => {
        next[creative.id] = { status: 'uploading' };
      });
      return next;
    });

    try {
      const response = await fetch('/api/meta/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId,
          adSetId,
          pageId,
          destinationUrl: destinationUrl.trim(),
          ctaType,
          creatives: selectedCreatives.map((creative) => ({
            id: creative.id,
            imageId: creative.image.id,
            category: creative.category,
            format: creative.format,
            copy: creative.copy,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Meta publishing failed.');
      }

      const results = (payload.results || []) as MetaPublishCreativeResult[];
      const failedIds: string[] = [];
      setPublishState((current) => {
        const next = { ...current };
        results.forEach((result) => {
          next[result.creativeId] = result.status === 'success'
            ? { ...result, status: 'success' }
            : { ...result, status: 'failed' };
          if (result.status === 'failed') failedIds.push(result.creativeId);
        });
        return next;
      });
      setSelectedIds(failedIds);
      setSendOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Meta publishing failed.';
      setMetaError(message);
      setPublishState((current) => {
        const next = { ...current };
        selectedCreatives.forEach((creative) => {
          next[creative.id] = {
            creativeId: creative.id,
            status: 'failed',
            error: message,
          };
        });
        return next;
      });
    } finally {
      setPublishing(false);
    }
  };

  if (generating) {
    const count = Math.max(2, requestedCount);

    return (
      <section className={styles.section} aria-live="polite" aria-busy="true">
        <div className={styles.heading}>
          <div>
            <p className="eyebrow">Generating</p>
            <h2>Building your creative variations</h2>
          </div>
          <span className="muted">{count} concepts</span>
        </div>

        <div className={styles.grid}>
          {Array.from({ length: count }, (_, index) => (
            <article className={`${styles.card} ${styles.skeletonCard}`} key={index}>
              <div className={`${styles.image} ${styles.skeleton}`} />
              <div className={styles.body}>
                <div className={styles.skeletonPills}>
                  <span className={`${styles.skeleton} ${styles.skeletonPill}`} />
                  <span className={`${styles.skeleton} ${styles.skeletonPillShort}`} />
                </div>
                <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
                <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
                <div className={`${styles.skeleton} ${styles.skeletonLineShort}`} />
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  if (!creatives.length) return null;

  return (
    <section className={styles.section}>
      <div className={styles.heading}>
        <div>
          <p className="eyebrow">Generated</p>
          <h2>Creative variations</h2>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setSelectedIds(allSelected ? [] : creatives.map((creative) => creative.id))}
          >
            {allSelected ? 'Clear selection' : 'Select all'}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!selectedCreatives.length}
            onClick={() => void openMetaDialog()}
          >
            Send to Meta{selectedCreatives.length ? ` (${selectedCreatives.length})` : ''}
          </button>
        </div>
      </div>

      <div className={styles.grid}>
        {creatives.map((creative) => {
          const state = publishState[creative.id];
          const selected = selectedIds.includes(creative.id);
          return (
            <article
              className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
              key={creative.id}
            >
              <label className={styles.selectionControl}>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleCreative(creative.id)}
                />
                <span>Select</span>
              </label>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={styles.image}
                src={creative.image.url}
                alt={`TRA creative variation ${creative.index}`}
              />
              <div className={styles.body}>
                <div className={styles.pills}>
                  <span className={styles.pill}>{CREATIVE_CATEGORY_LABELS[creative.category]}</span>
                  <span className={`${styles.pill} ${styles.secondary}`}>
                    {CREATIVE_FORMAT_LABELS[creative.format]}
                  </span>
                </div>
                <h3>{creative.copy.headline}</h3>
                <p>{creative.copy.primaryText}</p>
                {creative.copy.description ? (
                  <p className={styles.description}>{creative.copy.description}</p>
                ) : null}
                <p className={styles.creativeId}>ID: {creative.id}</p>
                {state ? (
                  <div
                    className={`${styles.publishStatus} ${
                      state.status === 'success'
                        ? styles.publishSuccess
                        : state.status === 'failed'
                          ? styles.publishFailed
                          : styles.publishUploading
                    }`}
                  >
                    {state.status === 'uploading' ? 'Uploading to Meta…' : null}
                    {state.status === 'success' ? (
                      <>
                        Created in Meta · PAUSED
                        {state.metaAdId ? <span>Ad ID: {state.metaAdId}</span> : null}
                      </>
                    ) : null}
                    {state.status === 'failed' ? (
                      <>
                        Failed
                        <span>{state.error || 'Meta did not create this ad.'}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {sendOpen ? (
        <div className={styles.modalBackdrop} role="presentation">
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="meta-send-title">
            <div className={styles.modalHeader}>
              <div>
                <p className="eyebrow">Meta Ads Manager</p>
                <h2 id="meta-send-title">Send {selectedCreatives.length} creative{selectedCreatives.length === 1 ? '' : 's'}</h2>
              </div>
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => setSendOpen(false)}
                disabled={publishing}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <p className={styles.safetyNote}>
              Every ad created by TRA will be created as PAUSED. This workflow does not change budgets or activate ads.
            </p>

            <div className={styles.formGrid}>
              <label>
                <span>Ad account</span>
                <select value={adAccountId} onChange={(event) => void chooseAccount(event.target.value)} disabled={loadingMeta || publishing}>
                  <option value="">Select an ad account</option>
                  {accounts.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
                </select>
              </label>
              <label>
                <span>Campaign</span>
                <select value={campaignId} onChange={(event) => void chooseCampaign(event.target.value)} disabled={!adAccountId || loadingMeta || publishing}>
                  <option value="">Select a campaign</option>
                  {campaigns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label>
                <span>Ad set</span>
                <select value={adSetId} onChange={(event) => setAdSetId(event.target.value)} disabled={!campaignId || loadingMeta || publishing}>
                  <option value="">Select an ad set</option>
                  {adSets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label>
                <span>Facebook Page</span>
                <select value={pageId} onChange={(event) => setPageId(event.target.value)} disabled={loadingMeta || publishing}>
                  <option value="">Select a Page</option>
                  {pages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label className={styles.fullWidth}>
                <span>Destination URL</span>
                <input
                  type="url"
                  placeholder="https://..."
                  value={destinationUrl}
                  onChange={(event) => setDestinationUrl(event.target.value)}
                  disabled={publishing}
                />
              </label>
              <label>
                <span>CTA</span>
                <select value={ctaType} onChange={(event) => setCtaType(event.target.value as MetaCtaType | '')} disabled={publishing}>
                  <option value="">No CTA button</option>
                  {META_CTA_TYPES.map((type) => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}
                </select>
              </label>
            </div>

            {loadingMeta ? <p className={styles.modalMessage}>Loading Meta options…</p> : null}
            {metaError ? <p className={styles.modalError}>{metaError}</p> : null}

            <div className={styles.modalActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => setSendOpen(false)} disabled={publishing}>Cancel</button>
              <button type="button" className={styles.primaryButton} onClick={() => void publishToMeta()} disabled={publishing || loadingMeta}>
                {publishing ? 'Sending…' : `Create ${selectedCreatives.length} paused ad${selectedCreatives.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
