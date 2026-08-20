'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  BRAND_GUIDELINE_FIELDS,
  DEFAULT_COMPANY_PROFILE,
  GUARDRAIL_FIELDS,
  KNOWLEDGE_BASE_FIELDS,
  getOverallCompletion,
  getSectionCompletion,
  mergeWebsiteProfile,
  type CompanyFields,
  type CompanyProfile,
  type CompanySectionId,
} from '@/lib/company/profile';
import styles from './company-view.module.css';

type CompanyTab = 'brandGuidelines' | 'knowledgeBase' | 'guardrails';

type WebsiteAnalysisResponse = {
  websiteUrl: string;
  pagesRead: string[];
  sections: Partial<Record<CompanySectionId, CompanyFields>>;
  notes: string[];
  error?: string;
};

const STORAGE_KEY = 'tra-company-profile-v2';

const COMPANY_TABS: Array<{ id: CompanyTab; label: string }> = [
  { id: 'knowledgeBase', label: 'Knowledge' },
  { id: 'brandGuidelines', label: 'Brand Guidelines' },
  { id: 'guardrails', label: 'Guardrails' },
];

const FIELD_SETS = {
  knowledgeBase: KNOWLEDGE_BASE_FIELDS,
  brandGuidelines: BRAND_GUIDELINE_FIELDS,
  guardrails: GUARDRAIL_FIELDS,
} as const;

const completionClass = (value: number) => {
  if (value >= 75) return styles.good;
  if (value >= 40) return styles.medium;
  return styles.low;
};

export function CompanyView() {
  const [activeTab, setActiveTab] = useState<CompanyTab>('knowledgeBase');
  const [profile, setProfile] = useState<CompanyProfile>(DEFAULT_COMPANY_PROFILE);
  const [websiteInput, setWebsiteInput] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [hasLoadedSavedProfile, setHasLoadedSavedProfile] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as CompanyProfile;
        setProfile(parsed);
        setWebsiteInput(parsed.websiteUrl || '');
      }
    } catch {
      // Ignore invalid local browser state and use repository defaults.
    } finally {
      setHasLoadedSavedProfile(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedSavedProfile) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  }, [hasLoadedSavedProfile, profile]);

  const completions = useMemo(
    () => ({
      brandGuidelines: getSectionCompletion(profile.brandGuidelines),
      knowledgeBase: getSectionCompletion(profile.knowledgeBase),
      guardrails: getSectionCompletion(profile.guardrails),
    }),
    [profile]
  );
  const overallCompletion = useMemo(() => getOverallCompletion(profile), [profile]);

  const updateField = (section: CompanyTab, key: string, value: string) => {
    setProfile((current) => ({
      ...current,
      [section]: {
        ...current[section],
        [key]: value,
      },
    }));
  };

  const analyzeWebsite = async (event: FormEvent) => {
    event.preventDefault();
    const websiteUrl = websiteInput.trim();
    if (!websiteUrl || isAnalyzing) return;

    setIsAnalyzing(true);
    setAnalysisMessage('');

    try {
      const response = await fetch('/api/company/analyze-website', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl }),
      });
      const payload = (await response.json()) as WebsiteAnalysisResponse;

      if (!response.ok) throw new Error(payload.error || 'Website analysis failed.');

      setProfile((current) =>
        mergeWebsiteProfile(current, payload.sections || {}, payload.websiteUrl)
      );
      setWebsiteInput(payload.websiteUrl);

      const filledCount = Object.values(payload.sections || {}).reduce(
        (sum, section) =>
          sum + Object.values(section || {}).filter((value) => value?.trim()).length,
        0
      );
      setAnalysisMessage(
        `Reviewed ${payload.pagesRead.length} page${payload.pagesRead.length === 1 ? '' : 's'} and found ${filledCount} supported field${filledCount === 1 ? '' : 's'}. Existing filled fields were preserved.`
      );
    } catch (error) {
      setAnalysisMessage(error instanceof Error ? error.message : 'Website analysis failed.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const activeFields = FIELD_SETS[activeTab];
  const activeValues = profile[activeTab];

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Company intelligence</p>
          <h1>Company Profile</h1>
          <p className={styles.intro}>
            This is the source the creative system should use for TRA. Blank fields mean the information has not been verified yet.
          </p>
        </div>
        <div className={styles.overallScore}>
          <strong>{overallCompletion}%</strong>
          <span>overall complete</span>
        </div>
      </header>

      <div className={styles.overallProgress} aria-label={`Overall company profile ${overallCompletion}% complete`}>
        <div
          className={`${styles.progressFill} ${completionClass(overallCompletion)}`}
          style={{ width: `${overallCompletion}%` }}
        />
      </div>

      <form className={styles.websiteCard} onSubmit={analyzeWebsite}>
        <div className={styles.websiteCopy}>
          <label htmlFor="company-website">Company website URL</label>
          <p>
            Enter the public website and the system will fill only information it can actually support from the pages it reads. It will not guess missing information.
          </p>
        </div>
        <div className={styles.websiteControls}>
          <input
            id="company-website"
            type="text"
            inputMode="url"
            placeholder="https://www.example.com"
            value={websiteInput}
            onChange={(event) => setWebsiteInput(event.target.value)}
          />
          <button type="submit" disabled={isAnalyzing || !websiteInput.trim()}>
            {isAnalyzing ? 'Analyzing…' : 'Analyze Website'}
          </button>
        </div>
        {analysisMessage ? <p className={styles.analysisMessage}>{analysisMessage}</p> : null}
      </form>

      <div className={styles.tabSummary}>
        {COMPANY_TABS.map((tab) => {
          const completion = completions[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              className={`${styles.summaryCard} ${activeTab === tab.id ? styles.activeSummary : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.label}</span>
              <strong>{completion}%</strong>
              <span className={styles.smallTrack}>
                <span
                  className={`${styles.smallFill} ${completionClass(completion)}`}
                  style={{ width: `${completion}%` }}
                />
              </span>
            </button>
          );
        })}
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Company resources">
        {COMPANY_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`company-panel-${tab.id}`}
            className={activeTab === tab.id ? styles.activeTab : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section
        id={`company-panel-${activeTab}`}
        className={styles.panel}
        role="tabpanel"
        aria-label={COMPANY_TABS.find((tab) => tab.id === activeTab)?.label}
      >
        <div className={styles.panelHeading}>
          <div>
            <h2>{COMPANY_TABS.find((tab) => tab.id === activeTab)?.label}</h2>
            <p>Fill or edit any field manually. Empty fields are intentionally treated as unknown.</p>
          </div>
          <span className={`${styles.completionPill} ${completionClass(completions[activeTab])}`}>
            {completions[activeTab]}% complete
          </span>
        </div>

        <div className={styles.fieldGrid}>
          {activeFields.map((field) => (
            <label key={field.key} className={field.multiline ? styles.fullField : styles.field}>
              <span>{field.label}</span>
              {field.multiline ? (
                <textarea
                  rows={5}
                  value={activeValues[field.key] || ''}
                  placeholder="Not yet verified"
                  onChange={(event) => updateField(activeTab, field.key, event.target.value)}
                />
              ) : (
                <input
                  type="text"
                  value={activeValues[field.key] || ''}
                  placeholder="Not yet verified"
                  onChange={(event) => updateField(activeTab, field.key, event.target.value)}
                />
              )}
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
