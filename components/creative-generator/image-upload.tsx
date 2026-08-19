'use client';

import { useEffect, useState } from 'react';
import type { MediaAsset } from '@/lib/media/types';

interface ImageUploadProps {
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

    if (nextFile && !ALLOWED_TYPES.includes(nextFile.type)) {
      setFile(null);
      setLocalPreview('');
      setError('Upload a PNG, JPEG, or WebP image.');
      return;
    }

    if (nextFile && nextFile.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setLocalPreview('');
      setError('The image is larger than the 10 MB upload limit.');
      return;
    }

    setFile(nextFile);
    setLocalPreview(nextFile ? URL.createObjectURL(nextFile) : '');
  };

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

  const upload = async () => {
    if (!file) return;

    setUploading(true);
    setError('');

    try {
      const planResponse = await fetch('/api/media/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
        }),
      });
      const plan = (await planResponse.json()) as UploadPlan;

      if (!planResponse.ok) {
        throw new Error(plan.error || 'Upload could not be prepared.');
      }

      if (!plan.direct) {
        onUploaded(await uploadThroughServer(file));
        return;
      }

      if (!plan.uploadUrl || !plan.media) {
        throw new Error('Upload could not be prepared.');
      }

      const putResponse = await fetch(plan.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
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
        throw new Error(confirmation.error || 'Uploaded image could not be validated.');
      }

      onUploaded(plan.media);
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
