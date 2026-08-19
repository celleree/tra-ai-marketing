import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import type { GeneratedCreative } from '@/lib/creatives/generated';

interface CreativeResultsProps {
  creatives: GeneratedCreative[];
}

export function CreativeResults({ creatives }: CreativeResultsProps) {
  if (!creatives.length) return null;

  return (
    <section className="results-section">
      <div className="results-heading">
        <div>
          <p className="eyebrow">Generated</p>
          <h2>Creative variations</h2>
        </div>
        <span className="muted">{creatives.length} concepts</span>
      </div>

      <div className="results-grid">
        {creatives.map((creative) => (
          <article className="creative-card" key={`${creative.image.id}-${creative.index}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="creative-image"
              src={creative.image.url}
              alt={`TRA creative variation ${creative.index}`}
            />
            <div className="creative-card-body">
              <div className="format-pills">
                <span className="format-pill">
                  {CREATIVE_FORMAT_LABELS[creative.primaryFormat]}
                </span>
                {creative.secondaryFormat ? (
                  <span className="format-pill format-pill-secondary">
                    {CREATIVE_FORMAT_LABELS[creative.secondaryFormat]}
                  </span>
                ) : null}
              </div>
              <h3>{creative.copy.headline}</h3>
              <p>{creative.copy.primaryText}</p>
              {creative.copy.description ? (
                <p className="creative-description">{creative.copy.description}</p>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
