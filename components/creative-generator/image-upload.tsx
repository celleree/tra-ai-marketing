'use client';

import { useEffect, useState } from 'react';
import type { MediaAsset } from '@/lib/media/types';

interface ImageUploadProps {
  onUploaded: (media: MediaAsset) => void;
}

export function ImageUpload({ onUploaded }: ImageUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const chooseFile = (nextFile: File | null) => {
    if (localPreview) URL.revokeObjectURL(localPreview);
    setError('');
    setFile(nextFile);
    setLocalPreview(nextFile ? URL.createObjectURL(nextFile) : '');
  };

  const upload = async () => {
    if (!file) return;

    setUploading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/media/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Upload failed.');
      }

      onUploaded(payload as MediaAsset);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : 'Upload failed.'
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Step 1</p>
          <h2>Source image</h2>
        </div>
        <span className="muted">PNG, JPEG or WebP · max 10 MB</span>
      </div>

      <label className="upload-dropzone">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => chooseFile(event.target.files?.[0] || null)}
        />
        {localPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={localPreview} alt="Selected source preview" />
        ) : (
          <div>
            <strong>Choose an image</strong>
            <p>Use an existing ad, graphic, screenshot, or visual concept.</p>
          </div>
        )}
      </label>

      <div className="row-actions">
        <button
          className="button button-primary"
          type="button"
          onClick={upload}
          disabled={!file || uploading}
        >
          {uploading ? 'Uploading…' : 'Upload image'}
        </button>
        {file ? <span className="muted">{file.name}</span> : null}
      </div>

      {error ? <p className="error-message">{error}</p> : null}
    </section>
  );
}
