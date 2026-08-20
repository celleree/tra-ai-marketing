'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import {
  CREATIVE_CATEGORIES,
  CREATIVE_CATEGORY_LABELS,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import type { MediaAsset } from '@/lib/media/types';
import type { ReferenceLibraryItem } from '@/lib/references/types';
import styles from './reference-library.module.css';

interface UploadPlan {
  direct: boolean;
  uploadUrl?: string;
  media?: MediaAsset;
  error?: string;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function ReferenceLibrary() {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [items, setItems] = useState<ReferenceLibraryItem[]>([]);
  const [selectedAngle, setSelectedAngle] =
    useState<CreativeCategoryId>('customer-problems');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [movingId, setMovingId] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState({ complete: 0, total: 0 });
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch('/api/references');
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not load references.');
        setItems((payload.items || []) as ReferenceLibraryItem[]);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Could not load references.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  const uploadThroughServer = async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('/api/media/upload', {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Upload failed.');
    return payload as MediaAsset;
  };

  const uploadOne = async (file: File): Promise<MediaAsset> => {
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

    if (!planResponse.ok) throw new Error(plan.error || 'Upload could not be prepared.');
    if (!plan.direct) return uploadThroughServer(file);
    if (!plan.uploadUrl || !plan.media) throw new Error('Upload could not be prepared.');

    const putResponse = await fetch(plan.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
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

  const uploadFiles = async (fileList: File[]) => {
    if (!fileList.length || uploading) return;

    setError('');
    const valid: File[] = [];
    const rejected: string[] = [];

    for (const file of fileList) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        rejected.push(`${file.name}: unsupported file type`);
      } else if (file.size > MAX_UPLOAD_BYTES) {
        rejected.push(`${file.name}: larger than 10 MB`);
      } else {
        valid.push(file);
      }
    }

    if (!valid.length) {
      setError(rejected.join(' · ') || 'Choose PNG, JPEG, or WebP images.');
      return;
    }

    setUploading(true);
    setProgress({ complete: 0, total: valid.length });
    const uploaded: MediaAsset[] = [];
    const failures = [...rejected];

    for (let index = 0; index < valid.length; index += 1) {
      const file = valid[index];
      try {
        uploaded.push(await uploadOne(file));
      } catch (uploadError) {
        failures.push(
          `${file.name}: ${uploadError instanceof Error ? uploadError.message : 'upload failed'}`
        );
      } finally {
        setProgress({ complete: index + 1, total: valid.length });
      }
    }

    if (uploaded.length) {
      try {
        const response = await fetch('/api/references', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: uploaded }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not save references.');
        const nextItems = (payload.items || []) as ReferenceLibraryItem[];
        setItems(nextItems);
        if (nextItems[0]?.angle) setSelectedAngle(nextItems[0].angle);
      } catch (registerError) {
        failures.push(
          registerError instanceof Error ? registerError.message : 'Could not save references.'
        );
      }
    }

    if (failures.length) setError(failures.join(' · '));
    setUploading(false);
  };

  const moveReference = async (id: string, angle: CreativeCategoryId) => {
    setMovingId(id);
    setError('');

    try {
      const response = await fetch('/api/references', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, angle }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not move reference.');
      setItems((payload.items || []) as ReferenceLibraryItem[]);
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : 'Could not move reference.');
    } finally {
      setMovingId('');
    }
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    void uploadFiles(files);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    if (!uploading) setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void uploadFiles(Array.from(event.dataTransfer.files || []));
  };

  const visibleItems = items.filter((item) => item.angle === selectedAngle);

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <h2>Reference library</h2>
        <p>
          Add strong ad examples here. AI automatically sorts every upload into one
          of the 15 fixed creative angles below.
        </p>
      </div>

      <div
        className={`${styles.uploader} ${dragActive ? styles.dragging : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          className={styles.fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={handleInput}
        />
        <div className={styles.uploadIcon} aria-hidden="true">+</div>
        <div className={styles.uploadCopy}>
          <strong>Add reference images</strong>
          <span>Upload one image or a whole batch. AI will place them into angle folders.</span>
        </div>
        <button
          className={styles.chooseButton}
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? 'Uploading & sorting…' : 'Choose images'}
        </button>
        <span className={styles.uploadMeta}>PNG, JPEG or WebP · up to 10 MB each · bulk upload supported</span>

        {uploading ? (
          <div className={styles.progress}>
            <div
              className={styles.progressBar}
              style={{ width: `${(progress.complete / Math.max(progress.total, 1)) * 100}%` }}
            />
            <span>{progress.complete} of {progress.total}</span>
          </div>
        ) : null}
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      <section className={styles.libraryLayout}>
        <aside className={styles.folderPanel}>
          <div className={styles.folderHeader}>
            <strong>Creative angles</strong>
            <span>15 folders</span>
          </div>

          <nav className={styles.folderList} aria-label="Reference angle folders">
            {CREATIVE_CATEGORIES.map((angle) => {
              const count = items.filter((item) => item.angle === angle).length;
              return (
                <button
                  key={angle}
                  type="button"
                  className={`${styles.folderButton} ${
                    selectedAngle === angle ? styles.folderButtonActive : ''
                  }`}
                  onClick={() => setSelectedAngle(angle)}
                >
                  <span className={styles.folderIcon} aria-hidden="true">▱</span>
                  <span className={styles.folderName}>{CREATIVE_CATEGORY_LABELS[angle]}</span>
                  <span className={styles.folderCount}>{count}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className={styles.library}>
          <div className={styles.libraryHeader}>
            <div>
              <span className={styles.libraryEyebrow}>Angle folder</span>
              <h3>{CREATIVE_CATEGORY_LABELS[selectedAngle]}</h3>
            </div>
            <span>{visibleItems.length} {visibleItems.length === 1 ? 'reference' : 'references'}</span>
          </div>

          {loading ? (
            <div className={styles.empty}>Loading references…</div>
          ) : visibleItems.length ? (
            <div className={styles.grid}>
              {visibleItems.map((item) => (
                <article key={item.id} className={styles.card}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.url} alt={item.originalName} />
                  <div className={styles.cardFooter}>
                    <div className={styles.fileName} title={item.originalName}>
                      {item.originalName}
                    </div>
                    <label className={styles.angleControl}>
                      <span>Angle</span>
                      <select
                        value={item.angle}
                        disabled={movingId === item.id}
                        onChange={(event) =>
                          void moveReference(item.id, event.target.value as CreativeCategoryId)
                        }
                      >
                        {CREATIVE_CATEGORIES.map((angle) => (
                          <option key={angle} value={angle}>
                            {CREATIVE_CATEGORY_LABELS[angle]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>
              <div className={styles.emptyIcon} aria-hidden="true">▧</div>
              <strong>No references in this angle yet</strong>
              <span>Upload references above and AI will sort them automatically.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
