'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import styles from './boomin-landing.module.css';

const PLACEHOLDERS = Array.from({ length: 18 }, (_, index) => index);

export function BoominLanding() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');

  const openStudio = () => {
    router.push('/studio');
  };

  return (
    <main className={styles.page}>
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.floatTrack}>
          {[...PLACEHOLDERS, ...PLACEHOLDERS].map((item, index) => (
            <div
              key={`${item}-${index}`}
              className={styles.placeholder}
              style={{
                '--offset': `${(item % 3) * 52}px`,
                '--delay': `${(item % 6) * -1.8}s`,
              } as React.CSSProperties}
            >
              <span>TRA</span>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.fade} aria-hidden="true" />

      <section className={styles.hero}>
        <h1>BOOMIN&apos;</h1>

        <div className={styles.composer}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                openStudio();
              }
            }}
            placeholder="What do you want to create?"
            rows={4}
            aria-label="Creative prompt"
          />

          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.addButton}
              aria-label="Add source creative"
              onClick={openStudio}
            >
              +
            </button>

            <button
              type="button"
              className={styles.sendButton}
              aria-label="Open TRA AI Marketing"
              onClick={openStudio}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 15V5M6 9l4-4 4 4" />
              </svg>
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
