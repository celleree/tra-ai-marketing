'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent,
} from 'react';
import { CreativeImageModelSelect } from '@/components/creative-generator/creative-image-model-select';
import { CreativePlacementSelect } from '@/components/creative-generator/creative-placement-select';
import type { CreativeImageModel } from '@/lib/creatives/image-models';
import type { CreativePlacement } from '@/lib/creatives/placements';
import type {
  CreativeSourceAsset,
  CreativeSourceMediaAsset,
  CreativeSourceRole,
} from '@/lib/media/types';
import {
  getCreativeSourceCountError,
  MAX_CREATIVE_SOURCE_ASSETS,
} from '@/lib/media/source-limits';
import {
  getCreativeSourceUploadInFlight,
  releaseCreativeSourceUpload,
  subscribeCreativeSourceUploadInFlight,
  tryAcquireCreativeSourceUpload,
} from '@/lib/media/source-upload-lock';
import styles from './creative-composer.module.css';

interface CreativeComposerProps {
  value: string;
  onChange: (value: string) => void;
  onUploadStart: () => void;
  onUploaded: (source: CreativeSourceAsset) => void;
  sourceAssets: CreativeSourceAsset[];
  onSourceRoleChange: (mediaId: string, role: CreativeSourceRole) => void;
  onSourceRemoved: (mediaId: string) => void;
  allowMultipleSources?: boolean;
  variationCount: number;
  onVariationCountChange: (value: number) => void;
  placement?: CreativePlacement;
  onPlacementChange?: (value: CreativePlacement) => void;
  imageModel?: CreativeImageModel;
  onImageModelChange?: (value: CreativeImageModel) => void;
  onSubmit: () => void;
  ready: boolean;
  generating: boolean;
}

interface UploadPlan {
  direct: boolean;
  uploadUrl?: string;
  media?: CreativeSourceMediaAsset;
  sourceRole?: CreativeSourceRole;
  error?: string;
}

type ServerUploadResponse = CreativeSourceMediaAsset & {
  sourceRole?: CreativeSourceRole;
  error?: string;
};

const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4'];
const MIN_VARIATIONS = 2;
const MAX_VARIATIONS = 30;

const ROLE_LABELS: Record<CreativeSourceRole, string> = {
  TRA_VIDEO: 'TRA_VIDEO',
  TRA_REFERENCE: 'TRA_REFERENCE',
  LAYOUT_REFERENCE: 'LAYOUT_REFERENCE',
};

export function CreativeComposer({
  value,
  onChange,
  onUploadStart,
  onUploaded,
  sourceAssets,
  onSourceRoleChange,
  onSourceRemoved,
  allowMultipleSources = true,
  variationCount,
  onVariationCountChange,
  placement,
  onPlacementChange,
  imageModel,
  onImageModelChange,
  onSubmit,
  ready,
  generating,
}: CreativeComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const uploadInFlightRef = useRef(false);
  const sharedUploadInFlight = useSyncExternalStore(
    subscribeCreativeSourceUploadInFlight,
    getCreativeSourceUploadInFlight,
    () => false
  );
  const [localPreview, setLocalPreview] = useState('');
  const [pendingName, setPendingName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');
  const uploadBusy = uploading || sharedUploadInFlight;
  const sourceLimitReached =
    allowMultipleSources && sourceAssets.length >= MAX_CREATIVE_SOURCE_ASSETS;

  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const uploadThroughServer = async (
    sourceFile: File,
    sourceRole: CreativeSourceRole
  ) => {
    const formData = new FormData();
    formData.append('file', sourceFile);
    formData.append('sourceRole', sourceRole);

    const response = await fetch('/api/media/upload', {
      method: 'POST',
      body: formData,
    });
    const payload = (await response.json()) as ServerUploadResponse;

    if (!response.ok) {
      throw new Error(payload.error || 'Upload failed.');
    }
    if (payload.sourceRole && payload.sourceRole !== sourceRole) {
      throw new Error('The uploaded source role could not be preserved.');
    }

    return payload as CreativeSourceMediaAsset;
  };

  const uploadFile = async (
    sourceFile: File,
    sourceRole: CreativeSourceRole
  ) => {
    const planResponse = await fetch('/api/media/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: sourceFile.name,
        mimeType: sourceFile.type,
        size: sourceFile.size,
        sourceRole,
      }),
    });
    const plan = (await planResponse.json()) as UploadPlan;

    if (!planResponse.ok) {
      throw new Error(plan.error || 'Upload could not be prepared.');
    }

    if (!plan.direct) {
      return uploadThroughServer(sourceFile, sourceRole);
    }

    if (!plan.uploadUrl || !plan.media) {
      throw new Error('Upload could not be prepared.');
    }
    if (plan.sourceRole && plan.sourceRole !== sourceRole) {
      throw new Error('The upload plan did not preserve the selected source role.');
    }

    const putResponse = await fetch(plan.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': sourceFile.type },
      body: sourceFile,
    });

    if (!putResponse.ok) {
      throw new Error('Direct media upload failed.');
    }

    const confirmResponse = await fetch('/api/media/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: plan.media.id,
        mimeType: plan.media.mimeType,
        mediaType: plan.media.mediaType,
        sourceRole,
      }),
    });
    const confirmation = await confirmResponse.json();

    if (!confirmResponse.ok) {
      throw new Error(
        confirmation.error || 'Uploaded media could not be validated.'
      );
    }

    return plan.media;
  };

  const validateFile = (file: File) => {
    if (
      !ALLOWED_IMAGE_TYPES.includes(file.type) &&
      !ALLOWED_VIDEO_TYPES.includes(file.type)
    ) {
      return 'Upload PNG, JPEG, WebP, or MP4 files.';
    }
    if (
      ALLOWED_IMAGE_TYPES.includes(file.type) &&
      file.size > MAX_IMAGE_UPLOAD_BYTES
    ) {
      return `${file.name} is larger than the 10 MB image limit.`;
    }
    return '';
  };

  const acceptFiles = async (files: File[]) => {
    if (
      !files.length ||
      uploadInFlightRef.current ||
      sharedUploadInFlight ||
      generating
    ) {
      return;
    }

    const selectedFiles = allowMultipleSources ? files : files.slice(0, 1);
    const sourceCountError = getCreativeSourceCountError(
      (allowMultipleSources ? sourceAssets.length : 0) + selectedFiles.length
    );
    if (sourceCountError) {
      setError(sourceCountError);
      return;
    }
    if (!tryAcquireCreativeSourceUpload()) return;

    const previewFile = selectedFiles.find((file) =>
      ALLOWED_IMAGE_TYPES.includes(file.type)
    );
    setLocalPreview(previewFile ? URL.createObjectURL(previewFile) : '');
    setPendingName(previewFile?.name || '');
    uploadInFlightRef.current = true;
    setUploading(true);
    setError('');
    onUploadStart();
    const failures: string[] = [];

    try {
      for (const file of selectedFiles) {
        const validationError = validateFile(file);
        if (validationError) {
          failures.push(validationError);
          continue;
        }

        const role: CreativeSourceRole = ALLOWED_VIDEO_TYPES.includes(file.type)
          ? 'TRA_VIDEO'
          : 'TRA_REFERENCE';

        try {
          const media = await uploadFile(file, role);
          onUploaded({ role, media });
        } catch (uploadError) {
          failures.push(
            uploadError instanceof Error ? uploadError.message : `${file.name} failed.`
          );
        }
      }
    } finally {
      uploadInFlightRef.current = false;
      releaseCreativeSourceUpload();
      setUploading(false);
      setLocalPreview('');
      setPendingName('');
      setError(failures.join(' '));
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    void acceptFiles(files);
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (!uploadBusy) setDragActive(true);
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
    void acceptFiles(Array.from(event.dataTransfer.files || []));
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
    if (
      ready &&
      !generating &&
      !sharedUploadInFlight &&
      !uploadInFlightRef.current
    ) {
      onSubmit();
    }
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
        accept="image/png,image/jpeg,image/webp,video/mp4"
        multiple={allowMultipleSources}
        disabled={uploadBusy || generating || sourceLimitReached}
        onChange={handleFileChange}
      />

      {localPreview && uploadBusy ? (
        <div className={styles.attachment}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={localPreview} alt="Selected source preview" />
          <div className={styles.attachmentCopy}>
            <strong>{pendingName}</strong>
            <span>Uploading…</span>
          </div>
        </div>
      ) : null}

      {sourceAssets.length ? (
        <div className={styles.attachmentList}>
          {sourceAssets.map((source) => (
            <div className={styles.attachmentRow} key={source.media.id}>
              <div className={styles.attachment}>
                {source.media.mediaType === 'IMAGE' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={source.media.url} alt="Uploaded creative source" />
                ) : (
                  <div className={styles.videoBadge} aria-hidden="true">
                    MP4
                  </div>
                )}
                <div className={styles.attachmentCopy}>
                  <strong>{source.media.originalName}</strong>
                  <span>{ROLE_LABELS[source.role]} · Ready</span>
                </div>
                <span className={styles.readyDot} aria-label="Upload ready" />
              </div>

              <div className={styles.attachmentActions}>
                <label>
                  <select
                    aria-label={`Source role for ${source.media.originalName}`}
                    value={source.role}
                    onChange={(event) =>
                      onSourceRoleChange(
                        source.media.id,
                        event.target.value as CreativeSourceRole
                      )
                    }
                    disabled={generating || source.media.mediaType === 'VIDEO'}
                  >
                    {source.media.mediaType === 'VIDEO' ? (
                      <option value="TRA_VIDEO">TRA_VIDEO</option>
                    ) : (
                      <>
                        <option value="TRA_REFERENCE">TRA_REFERENCE</option>
                        <option value="LAYOUT_REFERENCE">LAYOUT_REFERENCE</option>
                      </>
                    )}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => onSourceRemoved(source.media.id)}
                  disabled={generating}
                  aria-label={`Remove ${source.media.originalName}`}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <textarea
        className={styles.textarea}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={4}
        maxLength={4000}
        placeholder="Tell TRA AI what you want to create…"
      />

      <div className={styles.variationControl}>
        <div className={styles.variationMeta}>
          <span>Creatives</span>
          <strong>{variationCount}</strong>
        </div>
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

      <div className={styles.toolbar}>
        <div className={styles.tools}>
          <button
            className={styles.plusButton}
            type="button"
            aria-label="Add creative source assets"
            title="Add creative source assets"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadBusy || generating || sourceLimitReached}
          >
            +
          </button>
          {placement && onPlacementChange ? (
            <CreativePlacementSelect
              value={placement}
              onChange={onPlacementChange}
              disabled={generating}
            />
          ) : null}
          {imageModel && onImageModelChange ? (
            <CreativeImageModelSelect
              value={imageModel}
              onChange={onImageModelChange}
              disabled={generating}
            />
          ) : null}
          {uploadBusy || sourceLimitReached ? (
            <span className={styles.hint}>
              {uploadBusy
                ? 'Uploading source assets…'
                : `Maximum of ${MAX_CREATIVE_SOURCE_ASSETS} sources attached. Remove one to add another.`}
            </span>
          ) : null}
        </div>

        <div className={styles.submitGroup}>
          <span className={styles.count}>{value.length}/4000</span>
          <button
            className={styles.sendButton}
            type="button"
            aria-label={generating ? 'Generating creatives' : 'Generate creatives'}
            title="Generate creatives"
            disabled={!ready || generating || uploadBusy}
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
          <span>Images start as TRA_REFERENCE; MP4 files use TRA_VIDEO.</span>
        </div>
      ) : null}

      {error ? <p className={`error-message ${styles.error}`}>{error}</p> : null}
    </section>
  );
}
