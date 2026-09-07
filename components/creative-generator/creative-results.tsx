'use client';

import { useEffect, useMemo, useState } from 'react';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import type {
  MetaPublishBatchResult,
  MetaPublishCreativeResult,
} from '@/lib/meta/types';
import styles from '@/components/creative-generator/creative-results.module.css';

interface CreativeResultsProps {
  creatives: GeneratedCreative[];
  generating?: boolean;
  requestedCount?: number;
  generationComplete?: boolean;
  generationFailures?: Record<number, string>;
}

interface MetaItem {
  id: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
  currency?: string;
  accountStatus?: number;
}

interface MetaDefaults {
  adAccountId: string;
  pageId: string;
  destinationUrl: string;
  dailyBudget: number;
}

type PublishState =
  | { status: 'uploading' }
  | ({ status: 'success' } & MetaPublishCreativeResult)
  | ({ status: 'failed' } & MetaPublishCreativeResult);

const META_DEFAULTS_KEY = 'tra-meta-one-click-defaults-v1';

const readItems = async (response: Response) => {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Meta request failed.');
  }
  return (payload.items || []) as MetaItem[];
};

const isValidUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

const readSavedDefaults = (): MetaDefaults | null => {
  try {
    const raw = window.localStorage.getItem(META_DEFAULTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MetaDefaults>;
    if (
      typeof parsed.adAccountId !== 'string' ||
      typeof parsed.pageId !== 'string' ||
      typeof parsed.destinationUrl !== 'string' ||
      typeof parsed.dailyBudget !== 'number' ||
      !parsed.adAccountId ||
      !parsed.pageId ||
      !isValidUrl(parsed.destinationUrl) ||
      !Number.isFinite(parsed.dailyBudget)
    ) {
      return null;
    }
    return parsed as MetaDefaults;
  } catch {
    return null;
  }
};

export function CreativeResults({
  creatives,
  generating = false,
  requestedCount = 0,
  generationComplete = true,
  generationFailures = {},
}: CreativeResultsProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [sendAfterSetup, setSendAfterSetup] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [metaError, setMetaError] = useState('');
  const [accounts, setAccounts] = useState<MetaItem[]>([]);
  const [pages, setPages] = useState<MetaItem[]>([]);
  const [adAccountId, setAdAccountId] = useState('');
  const [pageId, setPageId] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [dailyBudget, setDailyBudget] = useState('20');
  const [metaDefaults, setMetaDefaults] = useState<MetaDefaults | null>(null);
  const [publishState, setPublishState] = useState<Record<string, PublishState>>({});
  const [batchResult, setBatchResult] = useState<MetaPublishBatchResult | null>(null);

  useEffect(() => {
    setSelectedIds([]);
    setPublishState({});
    setBatchResult(null);
  }, [creatives]);

  useEffect(() => {
    setMetaDefaults(readSavedDefaults());
  }, []);

  const selectedCreatives = useMemo(
    () => creatives.filter((creative) => selectedIds.includes(creative.id)),
    [creatives, selectedIds]
  );
  const allSelected = creatives.length > 0 && selectedIds.length === creatives.length;
  const selectedAccount = accounts.find((item) => item.id === adAccountId);
  const budgetCurrency = selectedAccount?.currency || 'account currency';

  const toggleCreative = (creativeId: string) => {
    setSelectedIds((current) =>
      current.includes(creativeId)
        ? current.filter((id) => id !== creativeId)
        : [...current, creativeId]
    );
  };

  const loadMetaAccounts = async () => {
    if (accounts.length) return accounts;

    setLoadingMeta(true);
    setMetaError('');
    try {
      const accountResponse = await fetch('/api/meta/ad-accounts', {
        cache: 'no-store',
      });
      const allAccounts = await readItems(accountResponse);
      const activeAccounts = allAccounts.filter(
        (item) => item.accountStatus === undefined || item.accountStatus === 1
      );
      setAccounts(activeAccounts);
      return activeAccounts;
    } catch (error) {
      setMetaError(
        error instanceof Error ? error.message : 'Unable to load Meta ad accounts.'
      );
      return [];
    } finally {
      setLoadingMeta(false);
    }
  };

  const loadPagesForAccount = async (
    nextAccountId: string,
    preferredPageId = ''
  ) => {
    setPages([]);
    setPageId('');
    if (!nextAccountId) return [];

    setLoadingMeta(true);
    setMetaError('');
    try {
      const response = await fetch(
        `/api/meta/pages?adAccountId=${encodeURIComponent(nextAccountId)}`,
        { cache: 'no-store' }
      );
      const nextPages = await readItems(response);
      setPages(nextPages);

      if (preferredPageId && nextPages.some((item) => item.id === preferredPageId)) {
        setPageId(preferredPageId);
      } else if (nextPages.length === 1) {
        setPageId(nextPages[0].id);
      }

      if (!nextPages.length) {
        setMetaError(
          'This ad account has no Facebook Pages it can promote with the current Meta access.'
        );
      }
      return nextPages;
    } catch (error) {
      setMetaError(
        error instanceof Error
          ? error.message
          : 'Unable to load Facebook Pages for this ad account.'
      );
      return [];
    } finally {
      setLoadingMeta(false);
    }
  };

  const chooseAdAccount = async (nextId: string) => {
    setAdAccountId(nextId);
    setMetaError('');
    await loadPagesForAccount(nextId);
  };

  const openMetaSetup = async (shouldSendAfterSave: boolean) => {
    setSendAfterSetup(shouldSendAfterSave);
    setMetaError('');
    const saved = metaDefaults;

    if (saved) {
      setDestinationUrl(saved.destinationUrl);
      setDailyBudget(String(saved.dailyBudget));
    }

    setSetupOpen(true);
    const activeAccounts = await loadMetaAccounts();
    const savedAccountIsActive = Boolean(
      saved && activeAccounts.some((item) => item.id === saved.adAccountId)
    );
    const accountToLoad = savedAccountIsActive
      ? saved!.adAccountId
      : activeAccounts.length === 1
        ? activeAccounts[0].id
        : '';

    setAdAccountId(accountToLoad);
    if (accountToLoad) {
      await loadPagesForAccount(
        accountToLoad,
        savedAccountIsActive ? saved!.pageId : ''
      );
    } else {
      setPages([]);
      setPageId('');
    }
  };

  const publishToMeta = async (config: MetaDefaults | null = metaDefaults) => {
    if (!selectedCreatives.length || publishing) return;
    if (!config) {
      await openMetaSetup(true);
      return;
    }

    setPublishing(true);
    setMetaError('');
    setBatchResult(null);
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
          adAccountId: config.adAccountId,
          pageId: config.pageId,
          destinationUrl: config.destinationUrl,
          dailyBudgetCents: Math.round(config.dailyBudget * 100),
          creativeIds: selectedCreatives.map((creative) => creative.id),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        const suffix = payload.campaignId
          ? ` Paused campaign ${payload.campaignId} was created before the failure.`
          : '';
        throw new Error(`${payload.error || 'Meta publishing failed.'}${suffix}`);
      }

      const batch = payload as MetaPublishBatchResult;
      setBatchResult(batch);
      const failedIds: string[] = [];
      setPublishState((current) => {
        const next = { ...current };
        batch.results.forEach((result) => {
          next[result.creativeId] = result.status === 'success'
            ? { ...result, status: 'success' }
            : { ...result, status: 'failed' };
          if (result.status === 'failed') failedIds.push(result.creativeId);
        });
        return next;
      });
      setSelectedIds(failedIds);

      if (failedIds.length) {
        setMetaError(
          `${failedIds.length} of ${batch.results.length} ads failed to create. The exact Meta stage/error is shown on each failed creative below.`
        );
      }
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

  const saveMetaSetup = async () => {
    const budget = Number(dailyBudget);
    if (!adAccountId || !pageId || !isValidUrl(destinationUrl.trim())) {
      setMetaError(
        'Choose an active ad account, a Page that account can promote, and a valid destination URL.'
      );
      return;
    }
    if (!Number.isFinite(budget) || budget < 5 || budget > 1000) {
      setMetaError('Daily budget must be between 5 and 1000 in the ad account currency.');
      return;
    }

    const nextDefaults: MetaDefaults = {
      adAccountId,
      pageId,
      destinationUrl: destinationUrl.trim(),
      dailyBudget: budget,
    };
    window.localStorage.setItem(META_DEFAULTS_KEY, JSON.stringify(nextDefaults));
    setMetaDefaults(nextDefaults);
    setSetupOpen(false);
    setMetaError('');

    if (sendAfterSetup) {
      await publishToMeta(nextDefaults);
    }
  };

  const failedIndexes = Object.keys(generationFailures).map(Number);
  if (!creatives.length && !generating && !failedIndexes.length) return null;

  const displayedCount = generating
    ? Math.max(2, requestedCount)
    : Math.max(...creatives.map((creative) => creative.index), ...failedIndexes, 0);
  const canPublish = generationComplete && !generating;

  const successfulAds =
    batchResult?.results.filter((result) => result.status === 'success').length || 0;

  return (
    <section className={styles.section} aria-live="polite" aria-busy={generating}>
      <div className={styles.heading}>
        <div>
          <p className="eyebrow">{generating ? 'Generating' : 'Creatives'}</p>
          <h2>{generating ? 'Building your creative variations' : 'Your creatives'}</h2>
        </div>
        <span className="muted">{displayedCount} creative{displayedCount === 1 ? '' : 's'}</span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() =>
              setSelectedIds(allSelected ? [] : creatives.map((creative) => creative.id))
            }
            disabled={publishing || !canPublish}
          >
            {allSelected ? 'Clear selection' : 'Select all'}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void openMetaSetup(false)}
            disabled={publishing || !canPublish}
          >
            {metaDefaults ? 'Meta setup' : 'Set up Meta'}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!selectedCreatives.length || publishing || !canPublish}
            onClick={() => void publishToMeta()}
          >
            {publishing
              ? 'Sending to Meta…'
              : `Send to Meta${
                  selectedCreatives.length ? ` (${selectedCreatives.length})` : ''
                }`}
          </button>
        </div>
      </div>

      {batchResult ? (
        <div className={styles.batchStatus}>
          <strong>
            {successfulAds
              ? 'Created in Meta · PAUSED'
              : 'Campaign and ad set created · ads failed'}
          </strong>
          <span>
            Campaign {batchResult.campaignId} · Ad set {batchResult.adSetId} ·{' '}
            {successfulAds}/{batchResult.results.length} ads created
          </span>
        </div>
      ) : null}
      {metaError && !setupOpen ? (
        <p className={styles.inlineError}>{metaError}</p>
      ) : null}

      <div className={styles.grid}>
        {Array.from({ length: displayedCount }, (_, offset) => {
          const index = offset + 1;
          const creative = creatives.find((item) => item.index === index);
          if (!creative) {
            const failure = generationFailures[index];
            if (failure) {
              return (
                <article className={`${styles.card} ${styles.failedCard}`} key={index}>
                  <div className={`${styles.image} ${styles.failedImage}`}>Failed</div>
                  <div className={styles.body}>
                    <p className={styles.failedLabel}>Creative {index} could not be completed.</p>
                    <p>{failure}</p>
                  </div>
                </article>
              );
            }

            return (
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
            );
          }

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
                  disabled={publishing || !canPublish}
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
                  <span className={styles.pill}>
                    {CREATIVE_CATEGORY_LABELS[creative.category]}
                  </span>
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
                    {state.status === 'uploading' ? 'Creating in Meta…' : null}
                    {state.status === 'success' ? (
                      <>
                        Created in Meta · PAUSED
                        {state.metaAdId ? <span>Ad ID: {state.metaAdId}</span> : null}
                        {state.ctaType ? (
                          <span>CTA: {state.ctaType.replaceAll('_', ' ')}</span>
                        ) : null}
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

      {setupOpen ? (
        <div className={styles.modalBackdrop} role="presentation">
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="meta-setup-title"
          >
            <div className={styles.modalHeader}>
              <div>
                <p className="eyebrow">Meta Ads Manager</p>
                <h2 id="meta-setup-title">One-time Meta setup</h2>
              </div>
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => setSetupOpen(false)}
                disabled={publishing}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <p className={styles.safetyNote}>
              These defaults stay in this browser. Each send creates a new PAUSED Traffic
              campaign, a PAUSED broad-US Landing Page Views ad set, and one PAUSED ad per
              selected creative. Nothing activates automatically.
            </p>

            <div className={styles.formGrid}>
              <label>
                <span>Default ad account</span>
                <select
                  value={adAccountId}
                  onChange={(event) => void chooseAdAccount(event.target.value)}
                  disabled={loadingMeta || publishing}
                >
                  <option value="">Select an active ad account</option>
                  {accounts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.id})
                      {item.currency ? ` · ${item.currency}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Default Facebook Page</span>
                <select
                  value={pageId}
                  onChange={(event) => setPageId(event.target.value)}
                  disabled={!adAccountId || loadingMeta || publishing}
                >
                  <option value="">
                    {adAccountId ? 'Select a promotable Page' : 'Select an ad account first'}
                  </option>
                  {pages.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.fullWidth}>
                <span>Destination URL</span>
                <input
                  type="url"
                  placeholder="https://your-landing-page-or-form.com"
                  value={destinationUrl}
                  onChange={(event) => setDestinationUrl(event.target.value)}
                  disabled={publishing}
                />
              </label>
              <label>
                <span>Daily budget if activated ({budgetCurrency})</span>
                <input
                  type="number"
                  min="5"
                  max="1000"
                  step="1"
                  value={dailyBudget}
                  onChange={(event) => setDailyBudget(event.target.value)}
                  disabled={publishing}
                />
              </label>
            </div>

            <p className={styles.setupHint}>
              Only Facebook Pages that the selected ad account can actually promote are shown.
              CTA is chosen automatically from each creative's copy. This MVP uses separate ads
              rather than dynamic creative so every generated concept is easy to inspect in Ads
              Manager.
            </p>
            {loadingMeta ? (
              <p className={styles.modalMessage}>Loading Meta options…</p>
            ) : null}
            {metaError ? <p className={styles.modalError}>{metaError}</p> : null}

            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setSetupOpen(false)}
                disabled={publishing}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void saveMetaSetup()}
                disabled={publishing || loadingMeta}
              >
                {sendAfterSetup
                  ? `Save & create ${selectedCreatives.length} paused ad${
                      selectedCreatives.length === 1 ? '' : 's'
                    }`
                  : 'Save setup'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
