'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { storeLandingCreativeDraft } from '@/lib/creatives/landing-draft';
import type {
  CreativeSourceAsset,
  CreativeSourceRole,
} from '@/lib/media/types';
import { CreativeComposer } from '@/components/creative-generator/creative-composer';
import styles from './momentum-landing.module.css';

const COLUMN_COUNT = 6;
const CARDS_PER_COLUMN = 7;
const CARD_ITEMS = Array.from({ length: CARDS_PER_COLUMN }, (_, index) => index);

export function MomentumLanding() {
  const router = useRouter();
  const [sourceAsset, setSourceAsset] = useState<CreativeSourceAsset | null>(null);
  const [context, setContext] = useState('');
  const [variationCount, setVariationCount] = useState(4);
  const [submitting, setSubmitting] = useState(false);

  const ready = Boolean(context.trim());

  const handleUploaded = (source: CreativeSourceAsset) => {
    setSourceAsset(source);
  };

  const handleSourceRoleChange = (
    mediaId: string,
    role: CreativeSourceRole
  ) => {
    setSourceAsset((current) =>
      current?.media.id === mediaId ? { ...current, role } : current
    );
  };

  const handleSourceRemoved = (mediaId: string) => {
    setSourceAsset((current) =>
      current?.media.id === mediaId ? null : current
    );
  };

  const openStudioAndGenerate = () => {
    if (!ready || submitting) return;

    setSubmitting(true);
    storeLandingCreativeDraft({
      version: 2,
      context: context.trim(),
      sourceAsset,
      variationCount,
      generateOnOpen: true,
    });
    router.push('/');
  };

  return (
    <main className={styles.page}>
      <div className={styles.backdrop} aria-hidden="true">
        {Array.from({ length: COLUMN_COUNT }, (_, columnIndex) => (
          <div
            key={columnIndex}
            className={`${styles.column} ${
              columnIndex % 2 === 0 ? styles.columnUp : styles.columnDown
            }`}
          >
            <div className={styles.columnTrack}>
              {[0, 1].map((setIndex) => (
                <div className={styles.cardSet} key={setIndex}>
                  {CARD_ITEMS.map((cardIndex) => (
                    <div
                      className={styles.placeholder}
                      key={`${columnIndex}-${setIndex}-${cardIndex}`}
                    >
                      <span>TRA</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.fade} aria-hidden="true" />

      <section className={styles.hero}>
        <h1>MOMENTUM</h1>

        <div className={styles.composerWrap}>
          <CreativeComposer
            value={context}
            onChange={setContext}
            onUploadStart={() => setSourceAsset(null)}
            onUploaded={handleUploaded}
            sourceAssets={sourceAsset ? [sourceAsset] : []}
            onSourceRoleChange={handleSourceRoleChange}
            onSourceRemoved={handleSourceRemoved}
            allowMultipleSources={false}
            variationCount={variationCount}
            onVariationCountChange={setVariationCount}
            onSubmit={openStudioAndGenerate}
            ready={ready}
            generating={submitting}
          />
        </div>
      </section>
    </main>
  );
}
