import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import styles from '@/components/creative-generator/creative-results.module.css';

interface CreativeResultsProps {
  creatives: GeneratedCreative[];
}

export function CreativeResults({ creatives }: CreativeResultsProps) {
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
                  {CREATIVE_FORMAT_LABELS[creative.primaryFormat]}
                </span>
                {creative.secondaryFormat ? (
                  <span className={`${styles.pill} ${styles.secondary}`}>
                    {CREATIVE_FORMAT_LABELS[creative.secondaryFormat]}
                  </span>
                ) : null}
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
