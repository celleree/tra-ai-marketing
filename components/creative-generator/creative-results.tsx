import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import styles from '@/components/creative-generator/creative-results.module.css';

interface CreativeResultsProps {
  creatives: GeneratedCreative[];
  generating?: boolean;
  requestedCount?: number;
}

export function CreativeResults({
  creatives,
  generating = false,
  requestedCount = 0,
}: CreativeResultsProps) {
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
        <span className="muted">{creatives.length} concepts</span>
      </div>

      <div className={styles.grid}>
        {creatives.map((creative) => (
          <article className={styles.card} key={`${creative.image.id}-${creative.index}`}>
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
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
