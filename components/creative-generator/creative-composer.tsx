'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent,
} from 'react';
import type { MediaAsset } from '@/lib/media/types';
import styles from './creative-composer.module.css';

interface CreativeComposerProps {
  value: string;
  onChange: (value: string) => void;
  onUploadStart: () => void;
  onUploaded: (media: MediaAsset) => void;
  variationCount: number;
  onVariationCountChange: (value: number) => void;
  onSubmit: () => void;
  ready: boolean;
  generating: boolean;
}

interface UploadPlan {
  direct: boolean;
  uploadUrl?: string;
  media?: MediaAsset;
  error?: string;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MIN_VARIATIONS = 2;
const MAX_VARIATIONS = 30;

export function CreativeComposer({
  value,
  onChange,
  onUploadStart,
  onUploaded,
  variationCount,
  onVariationCountChange,
  onSubmit,
  ready,
  generating,
}: CreativeComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [localPreview, setLocalPreview] = useState('');
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadReady, setUploadReady] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const uploadThroughServer = async (sourceFile: File) => {
    const formData = new FormData();
    formData.append('file', sourceFile);

    const response = await fetch('/api/media/upload', {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Upload failed.');
    }

    return payload as MediaAsset;
  };

  const uploadFile = async (sourceFile: File) => {
    setUploading(true);
    setUploadReady(false);
    setError('');
    onUploadStart();

    try {
      const planResponse = await fetch('/api/media/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: sourceFile.name,
          mimeType: sourceFile.type,
          size: sourceFile.size,
        }),
      });
      const plan = (await planResponse.json()) as UploadPlan;

      if (!planResponse.ok) {
        throw new Error(plan.error || 'Upload could not be prepared.');
      }

      if (!plan.direct) {
        const media = await uploadThroughServer(sourceFile);
        onUploaded(media);
        setUploadReady(true);
        return;
      }

      if (!plan.uploadUrl || !plan.media) {
        throw new Error('Upload could not be prepared.');
      }

      const putResponse = await fetch(plan.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': sourceFile.type },
        body: sourceFile,
      });

      if (!putResponse.ok) {
        throw new Error('Direct image upload failed.');
      }

      const confirmResponse = await fetch('/api/media/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId: plan.media.id }),
      });
      const confirmation = await confirmResponse.json();

      if (!confirmResponse.ok) {
        throw new Error(
          confirmation.error || 'Uploaded image could not be validated.'
        );
      }

      onUploaded(plan.media);
      setUploadReady(true);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : 'Upload failed.'
      );
    } finally {
      setUploading(false);
    }
  };

  const acceptFile = (nextFile: File | null) => {
    if (!nextFile || uploading) return;

    setError('');

    if (!ALLOWED_TYPES.includes(nextFile.type)) {
      setError('Upload a PNG, JPEG, or WebP image.');
      return;
    }

    if (nextFile.size > MAX_UPLOAD_BYTES) {
      setError('The image is larger than the 10 MB upload limit.');
      return;
    }

    if (localPreview) URL.revokeObjectURL(localPreview);
    setLocalPreview(URL.createObjectURL(nextFile));
    setFileName(nextFile.name);
    void uploadFile(nextFile);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] || null;
    event.target.value = '';
    acceptFile(nextFile);
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (!uploading) setDragActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    acceptFile(event.dataTransfer.files?.[0] || null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();
    if (ready && !generating) onSubmit();
  };

  const sliderProgress =
    ((variationCount - MIN_VARIATIONS) /
      (MAX_VARIATIONS - MIN_VARIATIONS)) *
    100;
  const sliderStyle = {
    '--slider-progress': `${sliderProgress}%`,
  } as CSSProperties;

  return (
    <section
      className={`${styles.composer} ${dragActive ? styles.dragging : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        className={styles.fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
      />

      {localPreview ? (
        <div className={styles.attachment}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={localPreview} alt="Selected source creative" />
          <div className={styles.attachmentCopy}>
            <strong>{fileName}</strong>
            <span>
              {uploading ? 'Uploading…' : uploadReady ? 'Ready' : 'Upload failed'}
            </span>
          </div>
          {uploadReady ? (
            <span className={styles.readyDot} aria-label="Upload ready" />
          ) : null}
        </div>
      ) : null}

      <div className={styles.composerBody}>
        <textarea
          className={styles.textarea}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={7}
          maxLength={4000}
          placeholder="Tell TRA AI what you want to create…"
        />

        <div className={styles.variationControl}>
          <output
            className={styles.variationValue}
            htmlFor="creative-variation-slider"
            aria-live="polite"
          >
            {variationCount}
          </output>
          <span className={styles.variationLabel}>Creatives</span>
          <span className={styles.rangeEndpoint}>30</span>
          <div className={styles.sliderWrap}>
            <input
              id="creative-variation-slider"
              className={styles.variationSlider}
              type="range"
              min={MIN_VARIATIONS}
              max={MAX_VARIATIONS}
              step={1}
              value={variationCount}
              style={sliderStyle}
              aria-label="Number of creatives to generate"
              onChange={(event) =>
                onVariationCountChange(Number(event.target.value))
              }
              disabled={generating}
            />
          </div>
          <span className={styles.rangeEndpoint}>2</span>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.tools}>
          <button
            className={styles.plusButton}
            type="button"
            aria-label="Add source creative"
            title="Add source creative"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            +
          </button>
          <span className={styles.hint}>
            {uploading
              ? 'Uploading source creative…'
              : localPreview
                ? 'Source creative attached'
                : 'Add an image or drag it here'}
          </span>
        </div>

        <div className={styles.submitGroup}>
          <span className={styles.count}>{value.length}/4000</span>
          <button
            className={styles.sendButton}
            type="button"
            aria-label={generating ? 'Generating creatives' : 'Generate creatives'}
            title="Generate creatives"
            disabled={!ready || generating}
            onClick={onSubmit}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 15V5M6 9l4-4 4 4" />
            </svg>
          </button>
        </div>
      </div>

      {dragActive ? (
        <div className={styles.dropOverlay} aria-hidden="true">
          <strong>Drop to attach</strong>
          <span>The file will upload automatically.</span>
        </div>
      ) : null}

      {error ? <p className={`error-message ${styles.error}`}>{error}</p> : null}
    </section>
  );
}
