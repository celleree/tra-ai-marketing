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

interface FinderResponse {
  items?: ReferenceLibraryItem[];
  imported?: number;
  discovered?: number;
  failures?: string[];
  error?: string;
  needsSetup?: boolean;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3.5 7.75A2.25 2.25 0 0 1 5.75 5.5H9l2 2h7.25a2.25 2.25 0 0 1 2.25 2.25v7.5a2.25 2.25 0 0 1-2.25 2.25H5.75a2.25 2.25 0 0 1-2.25-2.25v-9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 7h15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9.25 3.75h5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M7 7.25 7.7 19a1.75 1.75 0 0 0 1.75 1.65h5.1A1.75 1.75 0 0 0 16.3 19L17 7.25"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 10.5v6.25M14 10.5v6.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="10" r="1.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="m5.5 17 4.25-4 2.75 2.5 2.25-2 3.75 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ReferenceLibrary() {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [items, setItems] = useState<ReferenceLibraryItem[]>([]);
  const [selectedAngle, setSelectedAngle] =
    useState<CreativeCategoryId>('customer-problems');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [finding, setFinding] = useState(false);
  const [finderMessage, setFinderMessage] = useState('');
  const [movingId, setMovingId] = useState('');
  const [deleting, setDeleting] = useState(false);
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

  const findWinningCreatives = async () => {
    if (finding) return;
    setFinding(true);
    setError('');
    setFinderMessage('Searching active tax-relief ads…');

    try {
      const response = await fetch('/api/reference-finder', { method: 'POST' });
      const payload = (await response.json()) as FinderResponse;
      if (!response.ok) throw new Error(payload.error || 'Creative search failed.');

      const nextItems = (payload.items || []) as ReferenceLibraryItem[];
      setItems(nextItems);
      setSelectedIds([]);

      const imported = payload.imported || 0;
      const discovered = payload.discovered || 0;
      if (imported > 0) {
        const firstImported = nextItems.find((item) => item.origin === 'ai-found');
        if (firstImported?.angle) setSelectedAngle(firstImported.angle);
        setFinderMessage(
          `Added ${imported} AI-found reference${imported === 1 ? '' : 's'} from ${discovered} candidate${discovered === 1 ? '' : 's'}.`
        );
      } else {
        setFinderMessage(
          discovered
            ? 'Candidates were found, but none could be newly imported.'
            : 'No usable static-image candidates were found in this search.'
        );
      }

      if (payload.failures?.length) {
        setError(`${payload.failures.length} candidate import${payload.failures.length === 1 ? '' : 's'} failed. The successful imports were kept.`);
      }
    } catch (finderError) {
      setFinderMessage('');
      setError(
        finderError instanceof Error
          ? finderError.message
          : 'Creative search failed.'
      );
    } finally {
      setFinding(false);
    }
  };

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
    setFinderMessage('');
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
        setSelectedIds([]);
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
      setSelectedIds((current) => current.filter((selectedId) => selectedId !== id));
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : 'Could not move reference.');
    } finally {
      setMovingId('');
    }
  };

  const toggleSelection = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : [...current, id]
    );
  };

  const deleteSelected = async () => {
    if (!selectedIds.length || deleting) return;

    const count = selectedIds.length;
    const confirmed = window.confirm(
      `Delete ${count} selected reference${count === 1 ? '' : 's'}? This cannot be undone.`
    );
    if (!confirmed) return;

    setDeleting(true);
    setError('');

    try {
      const response = await fetch('/api/references', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Could not delete selected references.');
      }

      setItems((payload.items || []) as ReferenceLibraryItem[]);
      setSelectedIds([]);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : 'Could not delete selected references.'
      );
    } finally {
      setDeleting(false);
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

  const changeFolder = (angle: CreativeCategoryId) => {
    setSelectedAngle(angle);
    setSelectedIds([]);
  };

  const visibleItems = items.filter((item) => item.angle === selectedAngle);

  return (
    <div className={styles.page}>
      <div className={styles.introRow}>
        <div className={styles.intro}>
          <h2>Reference library</h2>
          <p>
            Add strong ad examples here. AI automatically sorts every upload into one
            of the 15 fixed creative angles below.
          </p>
        </div>
        <button
          className={styles.findButton}
          type="button"
          disabled={finding || uploading}
          onClick={() => void findWinningCreatives()}
        >
          {finding ? 'Finding creatives…' : 'Find Winning Creatives'}
        </button>
      </div>

      {finderMessage ? <p className={styles.finderMessage}>{finderMessage}</p> : null}

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

      <div className={styles.selectionBar}>
        <span>
          {selectedIds.length
            ? `${selectedIds.length} selected`
            : 'Select references to manage them'}
        </span>
        <button
          className={styles.deleteButton}
          type="button"
          onClick={() => void deleteSelected()}
          disabled={!selectedIds.length || deleting}
          aria-label="Delete selected references"
          title="Delete selected references"
        >
          <TrashIcon />
          <span>{deleting ? 'Deleting…' : 'Delete'}</span>
        </button>
      </div>

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
                  onClick={() => changeFolder(angle)}
                >
                  <span className={styles.folderIcon}>
                    <FolderIcon />
                  </span>
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
              {visibleItems.map((item) => {
                const selected = selectedIds.includes(item.id);
                return (
                  <article
                    key={item.id}
                    className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
                  >
                    <label className={styles.cardCheckbox}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelection(item.id)}
                        aria-label={`Select ${item.originalName}`}
                      />
                      <span aria-hidden="true" />
                    </label>
                    {item.origin === 'ai-found' ? (
                      <span className={styles.aiFoundBadge}>AI Found</span>
                    ) : null}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.url} alt={item.originalName} />
                    <div className={styles.cardFooter}>
                      <div className={styles.fileName} title={item.originalName}>
                        {item.discovery?.advertiser || item.originalName}
                      </div>
                      {item.discovery?.sourceUrl ? (
                        <a
                          className={styles.sourceLink}
                          href={item.discovery.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View source ad
                        </a>
                      ) : null}
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
                );
              })}
            </div>
          ) : (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>
                <ImageIcon />
              </div>
              <strong>No references in this angle yet</strong>
              <span>Upload references above or use Find Winning Creatives.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
