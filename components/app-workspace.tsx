'use client';

import { useState } from 'react';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';

type AppSection = 'creative' | 'company';
type CompanyTab = 'brand-guidelines' | 'knowledge-base';

export function AppWorkspace() {
  const [section, setSection] = useState<AppSection>('creative');
  const [companyTab, setCompanyTab] = useState<CompanyTab>('brand-guidelines');

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <span>TRA</span>
          <strong>AI Marketing</strong>
        </div>

        <nav className="workspace-nav" aria-label="Main navigation">
          <button
            type="button"
            className={section === 'creative' ? 'workspace-nav-active' : ''}
            onClick={() => setSection('creative')}
          >
            Creative Generator
          </button>
          <button
            type="button"
            className={section === 'company' ? 'workspace-nav-active' : ''}
            onClick={() => setSection('company')}
          >
            Company
          </button>
        </nav>
      </aside>

      <div className="workspace-content">
        {section === 'creative' ? (
          <CreativeGenerator />
        ) : (
          <main className="company-shell">
            <header className="company-header">
              <p className="eyebrow">Company</p>
              <h1>Company</h1>
            </header>

            <div className="company-tabs" role="tablist" aria-label="Company">
              <button
                type="button"
                role="tab"
                aria-selected={companyTab === 'brand-guidelines'}
                className={companyTab === 'brand-guidelines' ? 'company-tab-active' : ''}
                onClick={() => setCompanyTab('brand-guidelines')}
              >
                Brand Guidelines
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={companyTab === 'knowledge-base'}
                className={companyTab === 'knowledge-base' ? 'company-tab-active' : ''}
                onClick={() => setCompanyTab('knowledge-base')}
              >
                Knowledge Base
              </button>
            </div>

            <section
              className="company-tab-panel"
              role="tabpanel"
              aria-label={
                companyTab === 'brand-guidelines' ? 'Brand Guidelines' : 'Knowledge Base'
              }
            />
          </main>
        )}
      </div>
    </div>
  );
}
