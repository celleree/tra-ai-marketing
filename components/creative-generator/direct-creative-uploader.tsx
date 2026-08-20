'use client';

import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import type { MediaAsset } from '@/lib/media/types';
import styles from './creative-create-mode.module.css';

interface DirectCreativeUploaderProps {
  onUploadStart: () => void;
  onUploaded: (creatives: GeneratedCreative[]) => void;
}

interface UploadPlan {
  direct: boolean;
  uploadUrl?: string;
  media?: MediaAsset;
  error?: string;
}

const MAX_FILES = 30;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function DirectCreativeUploader({
  onUploadStart,
  onUploaded,
}: DirectCreativeUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [primaryText, setPrimaryText] = useState('');
  const [headline, setHeadline] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');

  const validateFiles = (incoming: File[]) => {
    if (!incoming.length) return [];
    if (incoming.length > MAX_FILES) {
      setError(`Upload up to ${MAX_FILES} creatives at a time.`);
      return [];
    }

    const invalidType = incoming.find((file) => !ALLOWED_TYPES.includes(file.type));
    if (invalidType) {
      setError(`${invalidType.name} is not a PNG, JPEG, or WebP image.`);
      return [];
    }

    const tooLarge = incoming.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (tooLarge) {
      setError(`${tooLarge.name} is larger than the 10 MB upload limit.`);
      return [];
    }

    setError('');
    return incoming;
  };

  const acceptFiles = (incoming: File[]) => {
    if (uploading) return;
    const valid = validateFiles(incoming);
    if (valid.length) setFiles(valid);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFiles(Array.from(event.target.files || []));
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    acceptFiles(Array.from(event.dataTransfer.files || []));
  };

  const uploadThroughServer = async (sourceFile: File) => {
    const formData = new FormData();
    formData.append('file', sourceFile);
    const response = await fetch('/api/media/upload', { method: 'POST', body: formData });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Upload failed.');
    return payload as MediaAsset;
  };

  const uploadFile = async (sourceFile: File) => {
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

    if (!plan.direct) return uploadThroughServer(sourceFile);
    if (!plan.uploadUrl || !plan.media) {
      throw new Error('Upload could not be prepared.');
    }

    const putResponse = await fetch(plan.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': sourceFile.type },
      body: sourceFile,
    });
    if (!putResponse.ok) throw new Error('Direct image upload failed.');

    const confirmResponse = await fetch('/api/media/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: plan.media.id }),
    });
    const confirmation = await confirmResponse.json();
    if (!confirmResponse.ok) {
      throw new Error(confirmation.error || 'Uploaded image could not be validated.');
    }

    return plan.media;
  };

  const uploadBatch = async () => {
    if (!files.length || uploading) return;
    if (!headline.trim() || !primaryText.trim()) {
      setError('Add a headline and primary text before uploading the batch.');
      return;
    }

    setUploading(true);
    setError('');
    setProgress('Preparing uploads…');
    onUploadStart();

    const successful: Array<{ media: MediaAsset; sourceFile: File }> = [];
    const failed: File[] = [];

    for (let index = 0; index < files.length; index += 1) {
      const sourceFile = files[index];
      setProgress(`Uploading ${index + 1} of ${files.length}…`);
      try {
        successful.push({ media: await uploadFile(sourceFile), sourceFile });
      } catch {
        failed.push(sourceFile);
      }
    }

    if (successful.length) {
      const nextCreatives: GeneratedCreative[] = successful.map(
        ({ media, sourceFile }, index) => ({
          id: `upload_${media.id.replace(/^media_/, '')}`,
          index: index + 1,
          category: 'feature-led',
          format: 'direct-response',
          source: 'uploaded',
          image: media,
          copy: {
            primaryText: primaryText.trim(),
            headline: headline.trim(),
            description: description.trim(),
          },
        })
      );
      onUploaded(nextCreatives);
    }

    setFiles(failed);
    setUploading(false);
    setProgress('');

    if (failed.length) {
      setError(
        `${successful.length} uploaded successfully. ${failed.length} failed and remain selected so you can retry them.`
      );
    } else {
      setError('');
    }
  };

  const selectedSummary = files.length
    ? `${files.length} creative${files.length === 1 ? '' : 's'} selected`
    : 'PNG, JPEG, or WebP · up to 30 files · 10 MB each';

  return (
    <section className={styles.uploadPanel}>
      <div className={styles.uploadHeader}>
        <div>
          <p className="eyebrow">No image generation</p>
          <h2>Upload finished creatives</h2>
        </div>
        <span className={styles.creditBadge}>0 AI image credits</span>
      </div>
      <p className={styles.uploadDescription}>
        Upload completed ad images directly into the same media storage used by Meta publishing.
        The images are not regenerated or modified.
      </p>

      <div
        className={`${styles.dropzone} ${dragActive ? styles.dropzoneActive : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          className={styles.hiddenInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={handleFileChange}
          disabled={uploading}
        />
        <button
          type="button"
          className={styles.chooseButton}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          Choose images
        </button>
        <span>{selectedSummary}</span>
      </div>

      {files.length ? (
        <p className={styles.fileNames}>
          {files.slice(0, 4).map((file) => file.name).join(' · ')}
          {files.length > 4 ? ` · +${files.length - 4} more` : ''}
        </p>
      ) : null}

      <div className={styles.copyGrid}>
        <label className={styles.fullWidth}>
          <span>Primary text</span>
          <textarea
            value={primaryText}
            onChange={(event) => setPrimaryText(event.target.value)}
            placeholder="Primary text that appears above the ad"
            rows={4}
            disabled={uploading}
          />
        </label>
        <label>
          <span>Headline</span>
          <input
            value={headline}
            onChange={(event) => setHeadline(event.target.value)}
            placeholder="Ad headline"
            disabled={uploading}
          />
        </label>
        <label>
          <span>Description (optional)</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional description"
            disabled={uploading}
          />
        </label>
      </div>

      <div className={styles.uploadFooter}>
        <div>
          {progress ? <span className={styles.progress}>{progress}</span> : null}
          {error ? <span className={styles.uploadError}>{error}</span> : null}
        </div>
        <button
          type="button"
          className={styles.uploadButton}
          onClick={() => void uploadBatch()}
          disabled={!files.length || uploading}
        >
          {uploading
            ? 'Uploading…'
            : `Upload ${files.length || ''} creative${files.length === 1 ? '' : 's'}`.trim()}
        </button>
      </div>
    </section>
  );
}
