'use client';

import {
  CREATIVE_IMAGE_MODEL_LABELS,
  CREATIVE_IMAGE_MODELS,
  isCreativeImageModel,
  type CreativeImageModel,
} from '@/lib/creatives/image-models';
import styles from './creative-placement-select.module.css';

export function CreativeImageModelSelect({ value, onChange, disabled }: {
  value: CreativeImageModel;
  onChange: (value: CreativeImageModel) => void;
  disabled: boolean;
}) {
  return <label className={styles.field}>
    <select
      aria-label="Image model"
      title={`Image model: ${CREATIVE_IMAGE_MODEL_LABELS[value]}`}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        if (isCreativeImageModel(event.target.value)) onChange(event.target.value);
      }}
    >
      {CREATIVE_IMAGE_MODELS.map((model) => (
        <option key={model} value={model}>
          {CREATIVE_IMAGE_MODEL_LABELS[model]}
        </option>
      ))}
    </select>
  </label>;
}
