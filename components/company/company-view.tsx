'use client';

import { useState } from 'react';
import styles from './company-view.module.css';

type CompanyTab = 'brand-guidelines' | 'knowledge-base';

const COMPANY_TABS: Array<{ id: CompanyTab; label: string }> = [
  { id: 'brand-guidelines', label: 'Brand Guidelines' },
  { id: 'knowledge-base', label: 'Knowledge Base' },
];

export function CompanyView() {
  const [activeTab, setActiveTab] = useState<CompanyTab>('brand-guidelines');

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
        aria-label={
          activeTab === 'brand-guidelines' ? 'Brand Guidelines' : 'Knowledge Base'
        }
      />
    </div>
  );
}
