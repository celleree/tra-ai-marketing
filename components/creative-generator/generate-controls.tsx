'use client';

interface GenerateControlsProps {
  variationCount: number;
  onVariationCountChange: (value: number) => void;
  onGenerate: () => void;
  ready: boolean;
  generating: boolean;
}

const VARIATION_OPTIONS = [2, 4, 6, 8];

export function GenerateControls({
  variationCount,
  onVariationCountChange,
  onGenerate,
  ready,
  generating,
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
            disabled={generating}
          >
            {count}
          </button>
        ))}
      </div>

      <button
        className="button button-primary button-full"
        type="button"
        disabled={!ready || generating}
        onClick={onGenerate}
      >
        {generating ? 'Generating…' : 'Generate creatives'}
      </button>
      <p className="muted control-note">
        {generating
          ? 'Creating distinct TRA concepts across different categories.'
          : ready
            ? 'Categories drive the main idea; formats are presentation variations.'
            : 'Upload an image and add context first.'}
      </p>
    </section>
  );
}
