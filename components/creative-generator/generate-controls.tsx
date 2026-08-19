'use client';

interface GenerateControlsProps {
  variationCount: number;
  onVariationCountChange: (value: number) => void;
  ready: boolean;
}

const VARIATION_OPTIONS = [2, 4, 6, 8];

export function GenerateControls({
  variationCount,
  onVariationCountChange,
  ready,
}: GenerateControlsProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Step 3</p>
          <h2>Variations</h2>
        </div>
      </div>

      <div className="variation-options" role="group" aria-label="Variation count">
        {VARIATION_OPTIONS.map((count) => (
          <button
            key={count}
            type="button"
            className={
              count === variationCount
                ? 'variation-option variation-option-active'
                : 'variation-option'
            }
            onClick={() => onVariationCountChange(count)}
          >
            {count}
          </button>
        ))}
      </div>

      <button className="button button-primary button-full" type="button" disabled>
        Generate creatives
      </button>
      <p className="muted control-note">
        {ready
          ? 'Upload is ready. Image generation connects in the next implementation step.'
          : 'Upload an image and add context first.'}
      </p>
    </section>
  );
}
