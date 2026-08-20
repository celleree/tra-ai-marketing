'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { MediaAsset } from '@/lib/media/types';

interface CreativeComposerProps {
  value: string;
  onChange: (value: string) => void;
  onUploadStart: () => void;
  onUploaded: (media: MediaAsset) => void;
}

interface UploadPlan {
  direct: boolean;
  uploadUrl?: string;
  media?: MediaAsset;
  error?: string;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function CreativeComposer({
  value,
  onChange,
  onUploadStart,
  onUploaded,
}: CreativeComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!uploading) setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    acceptFile(event.dataTransfer.files?.[0] || null);
  };

  return (
    <section
      className={`creative-composer ${dragActive ? 'creative-composer-dragging' : ''}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        className="composer-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
      />

      {localPreview ? (
        <div className="composer-attachment">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={localPreview} alt="Selected source creative" />
          <div className="composer-attachment-copy">
            <strong>{fileName}</strong>
            <span>
              {uploading ? 'Uploading…' : uploadReady ? 'Ready' : 'Upload failed'}
            </span>
          </div>
          {uploadReady ? <span className="composer-ready-dot" aria-label="Upload ready" /> : null}
        </div>
      ) : null}

      <textarea
        className="composer-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={7}
        maxLength={4000}
        placeholder="Tell TRA AI what you want to create…"
      />

      <div className="composer-toolbar">
        <div className="composer-tools">
          <button
            className="composer-plus-button"
            type="button"
            aria-label="Add source creative"
            title="Add source creative"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            +
          </button>
          <span className="composer-hint">
            {uploading
              ? 'Uploading source creative…'
              : localPreview
                ? 'Source creative attached'
                : 'Add an image or drag it here'}
          </span>
        </div>
        <span className="composer-count">{value.length}/4000</span>
      </div>

      {dragActive ? (
        <div className="composer-drop-overlay" aria-hidden="true">
          <strong>Drop to attach</strong>
          <span>The file will upload automatically.</span>
        </div>
      ) : null}

      {error ? <p className="error-message composer-error">{error}</p> : null}
    </section>
  );
}
