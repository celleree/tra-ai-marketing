'use client';

import Image from 'next/image';
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

const LANDING_CREATIVES = [
  '/landing-creatives/we-get-it-and-we-can-help.png',
  '/landing-creatives/tax-stress-finally-has-a-plan.png',
  '/landing-creatives/start-your-free-tax-relief-consultation.png',
  '/landing-creatives/find-peace-of-mind-with-tax-relief.png',
  '/landing-creatives/business-owners-irs-back-taxes-social-post.png',
  '/landing-creatives/irs-notice-start-here-notes.png',
  '/landing-creatives/owe-the-irs-understand-your-options.png',
  '/landing-creatives/find-relief-from-tax-problems.png',
  '/landing-creatives/irs-tax-issues-clear-next-steps.png',
  '/landing-creatives/tax-debt-get-clear-next-steps.png',
  '/landing-creatives/just-got-a-tax-notice.png',
  '/landing-creatives/owe-the-irs-5k-50k-500k.png',
  '/landing-creatives/testimonial-joseph.png',
  '/landing-creatives/testimonial-mark.png',
];

function creativeForCard(columnIndex: number, cardIndex: number) {
  return LANDING_CREATIVES[
    (columnIndex * CARDS_PER_COLUMN + cardIndex) % LANDING_CREATIVES.length
  ];
}

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
    router.push('/studio');
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
                  {Array.from({ length: CARDS_PER_COLUMN }, (_, cardIndex) => {
                    const src = creativeForCard(columnIndex, cardIndex);
                    return (
                      <div
                        className={styles.creativeCard}
                        key={`${columnIndex}-${setIndex}-${cardIndex}`}
                      >
                        <Image
                          src={src}
                          alt=""
                          width={1254}
                          height={1672}
                          className={styles.creativeImage}
                          sizes="(max-width: 520px) 42vw, (max-width: 780px) 30vw, 18vw"
                        />
                      </div>
                    );
                  })}
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
