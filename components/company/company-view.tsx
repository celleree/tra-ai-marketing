'use client';

import { useState } from 'react';
import styles from './company-view.module.css';

type CompanyTab = 'knowledge-base' | 'brand-guidelines' | 'guardrails';

const COMPANY_TABS: Array<{ id: CompanyTab; label: string }> = [
  { id: 'knowledge-base', label: 'Knowledge Base' },
  { id: 'brand-guidelines', label: 'Brand Guidelines' },
  { id: 'guardrails', label: 'Guardrails' },
];

export function CompanyView() {
  const [activeTab, setActiveTab] = useState<CompanyTab>('knowledge-base');
  const activeLabel =
    COMPANY_TABS.find((tab) => tab.id === activeTab)?.label || 'Knowledge Base';

  return (
    <div className={styles.shell}>
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
        aria-label={activeLabel}
      />
    </div>
  );
}
