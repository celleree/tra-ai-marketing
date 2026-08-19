'use client';

interface ContextInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function ContextInput({ value, onChange }: ContextInputProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Step 2</p>
          <h2>Context</h2>
        </div>
      </div>

      <textarea
        className="context-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={7}
        maxLength={4000}
        placeholder="Example: Use this visual idea as inspiration for a TRA Facebook/Instagram tax-relief ad. Keep the concept simple, direct, and trustworthy."
      />
      <div className="input-footer">
        <span className="muted">Tell the system what to preserve, change, or emphasize.</span>
        <span className="muted">{value.length}/4000</span>
      </div>
    </section>
  );
}
