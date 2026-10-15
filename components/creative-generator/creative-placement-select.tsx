'use client';

import { isCreativePlacement, type CreativePlacement } from '@/lib/creatives/placements';
import styles from './creative-placement-select.module.css';

export function CreativePlacementSelect({ value, onChange, disabled }: {
  value: CreativePlacement;
  onChange: (value: CreativePlacement) => void;
  disabled: boolean;
}) {
  return <label className={styles.field}>
    <select
      aria-label="Creative format"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        if (isCreativePlacement(event.target.value)) onChange(event.target.value);
      }}
    >
      <option value="SQUARE_1_1">Square · 1:1</option>
      <option value="PORTRAIT_4_5">Portrait · 4:5</option>
      <option value="VERTICAL_9_16">Vertical · 9:16</option>
    </select>
  </label>;
}
