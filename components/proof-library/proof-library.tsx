'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { MAX_REVIEW_CSV_BYTES, parseReviewCsv } from '@/lib/proof/review-csv';
import type { ProofRecord } from '@/lib/proof/types';
import styles from './proof-library.module.css';

type ProofTab = ProofRecord['type'];
type EditableField = { key: number; value: string; stored?: string };
const tabs: Array<{ id: ProofTab; label: string }> = [
  { id: 'review', label: 'Reviews' },
  { id: 'case-study', label: 'Case Studies' },
];
const optional = (value: FormDataEntryValue | null) => {
  const text = String(value ?? '');
  return text.trim() ? text : undefined;
};
const textareaValue = (value: string) => value.replace(/\r\n?|\n/g, '\n');
export const proofLibraryLoadFailureMessage = 'Proof Library could not be loaded. No changes can be made until it loads successfully. Try again.';
export const normalizeProofTextareaEdit = (stored: string, submitted: string) =>
  submitted === textareaValue(stored) ? stored : submitted;
export const createProofEditFields = (values: string[], empty: string): EditableField[] =>
  values.length
    ? values.map((stored, key) => ({ key, stored, value: textareaValue(stored) }))
    : [{ key: 0, value: empty }];
export const proofEditValues = (fields: EditableField[]) => fields
  .filter(({ value }) => value.trim())
  .map(({ stored, value }) => stored === undefined ? value : normalizeProofTextareaEdit(stored, value));
const nextFieldKey = (fields: EditableField[]) =>
  Math.max(...fields.map(({ key }) => key)) + 1;

const recordItem = (record: ProofRecord) => {
  const {
    id: _id,
    status: _status,
    advertisingUseApproved: _advertisingUseApproved,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...item
  } = record;
  return item;
};

export function ProofLibraryError({ children }: { children: string }) {
  return <p className={styles.error} role="alert" aria-live="assertive">{children}</p>;
}

export function ProofRecordCard({
  record,
  onEdit = () => {},
  onToggle = () => {},
}: {
  record: ProofRecord;
  onEdit?: () => void;
  onToggle?: () => void;
}) {
  return (
    <article className={`${styles.card} ${record.status === 'INACTIVE' ? styles.inactive : ''}`}>
      <div className={styles.cardHeader}>
        <span className={styles.status}>{record.status === 'ACTIVE' ? 'Active' : 'Inactive'}</span>
        <div><button type="button" aria-label={`Edit proof ${record.id}`} onClick={onEdit}>Edit</button><button type="button" aria-label={`${record.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'} proof ${record.id}`} onClick={onToggle}>{record.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}</button></div>
      </div>
      <p className={styles.meta}>Advertising use: {record.advertisingUseApproved === true ? 'Approved' : 'Not approved'}</p>
      {record.type === 'review' ? (
        <>
          <blockquote>{record.originalReviewText}</blockquote>
          <p className={styles.meta}>{[
            record.attribution?.display,
            record.source,
            record.rating === undefined ? undefined : `${record.rating}/5`,
          ].filter(Boolean).join(' · ') || 'No source metadata supplied'}</p>
        </>
      ) : (
        <>
          <h3>{record.title}</h3>
          <strong>Verified facts</strong>
          <ul>{record.verifiedFacts.map((fact, index) => <li key={`${record.id}:fact:${index}`}>{fact}</li>)}</ul>
          <strong>Approved advertising wording</strong>
          <p className={styles.approved}>{record.approvedClaimWording}</p>
          <p className={styles.meta}>Source: {record.sourceNote}</p>
          {record.usageRestrictions ? <p><strong>Restrictions:</strong> {record.usageRestrictions}</p> : null}
          {record.requiredDisclaimer ? <p><strong>Required disclaimer:</strong> {record.requiredDisclaimer}</p> : null}
        </>
      )}
      {record.tags.length ? <p className={styles.tags}>{record.tags.map((tag) => <span key={tag}>{tag}</span>)}</p> : null}
      <small className={styles.id}>{record.id}</small>
    </article>
  );
}

export function ReviewCsvImport({ onImported }: { onImported: (records: ProofRecord[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const file = input.current?.files?.[0];
    setError('');
    setSuccess('');
    if (!file) {
      setError('Choose a CSV file to import.');
      return;
    }
    if (file.size > MAX_REVIEW_CSV_BYTES) {
      setError(`CSV files must be ${MAX_REVIEW_CSV_BYTES} bytes or smaller.`);
      return;
    }
    setPending(true);
    try {
      const items = parseReviewCsv(await file.text());
      const response = await fetch('/api/proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Reviews could not be imported.');
      onImported(payload.items);
      input.current?.form?.reset();
      setSuccess(`${payload.items.length} review${payload.items.length === 1 ? '' : 's'} imported.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reviews could not be imported.');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className={styles.import} onSubmit={submit} aria-busy={pending}>
      <fieldset disabled={pending}>
        <label>Import reviews from CSV<input ref={input} type="file" accept=".csv,text/csv" required /></label>
        <p>Required: <code>originalReviewText</code>. Optional: <code>source</code>, <code>displayAttribution</code> with explicit <code>attributionAllowed=true</code>, <code>rating</code>, and pipe-separated <code>tags</code>. Quote fields containing commas, quotes, or line breaks.</p>
        <p>Imports up to 100 reviews in one batch. Original review text is preserved exactly as supplied.</p>
        <button className={styles.primary} type="submit">{pending ? 'Importing…' : 'Import reviews'}</button>
      </fieldset>
      {error ? <ProofLibraryError>{error}</ProofLibraryError> : null}
      {success ? <p className={styles.success} role="status" aria-live="polite">{success}</p> : null}
    </form>
  );
}

function ProofForm({ type, record, onSaved, onCancel }: {
  type: ProofTab;
  record: ProofRecord | null;
  onSaved: (record: ProofRecord) => void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const matching = record?.type === type ? record : null;
  const [facts, setFacts] = useState(() => createProofEditFields(
    matching?.type === 'case-study' ? matching.verifiedFacts : [], ''
  ));
  const [tagFields, setTagFields] = useState(() =>
    createProofEditFields(matching?.tags ?? [], '')
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setSaving(true);
    setError('');
    const data = new FormData(form);
    const recordTags = proofEditValues(tagFields);
    let item: Record<string, unknown>;
    if (type === 'review') {
      const attributionAllowed = data.get('attributionAllowed') === 'on';
      const preserveOptionalTextareaText = (name: string, stored?: string) => {
        const submitted = String(data.get(name) ?? '');
        const text = stored === undefined
          ? submitted
          : normalizeProofTextareaEdit(stored, submitted);
        return optional(text);
      };
      const display = preserveOptionalTextareaText(
        'displayAttribution',
        matching?.type === 'review' ? matching.attribution?.display : undefined
      );
      if (attributionAllowed && !display) {
        setError('Add display attribution or clear attribution permission.');
        setSaving(false);
        return;
      }
      const rating = optional(data.get('rating'));
      const source = preserveOptionalTextareaText(
        'source',
        matching?.type === 'review' ? matching.source : undefined
      );
      const submittedReviewText = String(data.get('originalReviewText') ?? '');
      const originalReviewText = matching?.type === 'review'
        ? normalizeProofTextareaEdit(matching.originalReviewText, submittedReviewText)
        : submittedReviewText;
      item = {
        type,
        originalReviewText,
        ...(source ? { source } : {}),
        ...(attributionAllowed ? { attribution: { display, allowed: true } } : {}),
        ...(rating ? { rating: Number(rating) } : {}),
        tags: recordTags,
      };
    } else {
      const preserveCaseText = (name: string, stored = '') =>
        normalizeProofTextareaEdit(stored, String(data.get(name) ?? ''));
      item = {
        type,
        title: preserveCaseText('title', matching?.type === 'case-study' ? matching.title : ''),
        verifiedFacts: proofEditValues(facts),
        approvedClaimWording: preserveCaseText('approvedClaimWording', matching?.type === 'case-study' ? matching.approvedClaimWording : ''),
        sourceNote: preserveCaseText('sourceNote', matching?.type === 'case-study' ? matching.sourceNote : ''),
        ...(optional(data.get('usageRestrictions')) ? { usageRestrictions: preserveCaseText('usageRestrictions', matching?.type === 'case-study' ? matching.usageRestrictions : '') } : {}),
        ...(optional(data.get('requiredDisclaimer')) ? { requiredDisclaimer: preserveCaseText('requiredDisclaimer', matching?.type === 'case-study' ? matching.requiredDisclaimer : '') } : {}),
        tags: recordTags,
      };
    }
    const body = matching
      ? {
          id: matching.id,
          expectedUpdatedAt: matching.updatedAt,
          status: matching.status,
          advertisingUseApproved: data.get('advertisingUseApproved') === 'on',
          item,
        }
      : { items: [item] };
    try {
      const response = await fetch('/api/proof', {
        method: matching ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Proof record could not be saved.');
      onSaved(matching ? payload.item : payload.items[0]);
      if (!matching) {
        form.reset();
        setFacts(createProofEditFields([], ''));
        setTagFields(createProofEditFields([], ''));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Proof record could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-busy={saving}>
      <fieldset className={styles.fields} disabled={saving}>
      <div className={styles.formHeader}><h2>{matching ? 'Edit' : 'Add'} {type === 'review' ? 'review' : 'case study'}</h2>{matching ? <button type="button" onClick={onCancel}>Cancel</button> : null}</div>
      {type === 'review' ? <>
        <label>Exact original review text<textarea name="originalReviewText" rows={6} required defaultValue={matching?.type === 'review' ? matching.originalReviewText : ''} /></label>
        <div className={styles.grid}><label>Source<textarea name="source" rows={2} defaultValue={matching?.type === 'review' ? matching.source : ''} /></label><label>Rating (1–5)<input name="rating" type="number" min="1" max="5" step="any" defaultValue={matching?.type === 'review' ? matching.rating : ''} /></label></div>
        <label>Display attribution<textarea name="displayAttribution" rows={2} defaultValue={matching?.type === 'review' ? matching.attribution?.display : ''} /></label>
        <label className={styles.check}><input name="attributionAllowed" type="checkbox" defaultChecked={matching?.type === 'review' && Boolean(matching.attribution)} /> Permission confirmed for display attribution</label>
      </> : <>
        <label>Title / internal label<textarea name="title" rows={2} required defaultValue={matching?.type === 'case-study' ? matching.title : ''} /></label>
        <div className={styles.facts}><strong>Verified facts</strong>{facts.map((fact, index) => <div className={styles.fact} key={fact.key}>
          <label>Fact {index + 1}<textarea rows={2} required value={fact.value} onChange={(event) => setFacts((current) => current.map((field) => field.key === fact.key ? { ...field, value: event.target.value } : field))} /></label>
          {facts.length > 1 ? <button type="button" onClick={() => setFacts((current) => current.filter(({ key }) => key !== fact.key))}>Remove fact</button> : null}
        </div>)}<button type="button" onClick={() => setFacts((current) => [...current, { key: nextFieldKey(current), value: '' }])}>Add fact</button></div>
        <label>Approved advertising wording<textarea name="approvedClaimWording" rows={4} required defaultValue={matching?.type === 'case-study' ? matching.approvedClaimWording : ''} /></label>
        <label>Supporting / source note<textarea name="sourceNote" rows={3} required defaultValue={matching?.type === 'case-study' ? matching.sourceNote : ''} /></label>
        <label>Usage restrictions<textarea name="usageRestrictions" rows={2} defaultValue={matching?.type === 'case-study' ? matching.usageRestrictions : ''} /></label>
        <label>Required disclaimer<textarea name="requiredDisclaimer" rows={2} defaultValue={matching?.type === 'case-study' ? matching.requiredDisclaimer : ''} /></label>
      </>}
      {matching ? <label className={styles.check}><input name="advertisingUseApproved" type="checkbox" defaultChecked={matching.advertisingUseApproved === true} /> Explicitly approve this proof record for advertising use</label> : <p className={styles.note}>New proof records are not approved for advertising use. Edit the saved record to approve it explicitly.</p>}
      <div className={styles.facts}><strong>Tags</strong>{tagFields.map((tag, index) => <div className={styles.fact} key={tag.key}>
        <label>Tag {index + 1}<textarea rows={2} value={tag.value} onChange={(event) => setTagFields((current) => current.map((field) => field.key === tag.key ? { ...field, value: event.target.value } : field))} /></label>
        {tagFields.length > 1 || tag.value ? <button type="button" onClick={() => setTagFields((current) => current.length === 1 ? [{ key: nextFieldKey(current), value: '' }] : current.filter(({ key }) => key !== tag.key))}>Remove tag</button> : null}
      </div>)}<button type="button" onClick={() => setTagFields((current) => [...current, { key: nextFieldKey(current), value: '' }])}>Add tag</button></div>
      {error ? <ProofLibraryError>{error}</ProofLibraryError> : null}
      <button className={styles.primary} type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </fieldset>
    </form>
  );
}

export function ProofLibrary({ initialItems = [] }: { initialItems?: ProofRecord[] }) {
  const [items, setItems] = useState(initialItems);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<ProofTab>('review');
  const [editing, setEditing] = useState<ProofRecord | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/proof');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Proof Library could not be loaded.');
      setItems(payload.items);
      setLoaded(true);
    } catch {
      setLoaded(false);
      setError(proofLibraryLoadFailureMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = (record: ProofRecord) => {
    setItems((current) => current.some(({ id }) => id === record.id)
      ? current.map((item) => item.id === record.id ? record : item)
      : [record, ...current]);
    setEditing((current) => current?.id === record.id ? null : current);
  };
  const imported = (records: ProofRecord[]) => {
    setItems((current) => [...records, ...current]);
  };
  const toggle = async (record: ProofRecord) => {
    setError('');
    try {
      const response = await fetch('/api/proof', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: record.id, expectedUpdatedAt: record.updatedAt, status: record.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE', item: recordItem(record) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Proof status could not be updated.');
      saved(payload.item);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Proof status could not be updated.'); }
  };
  const visible = items.filter(({ type }) => type === activeTab);

  return (
    <div className={styles.shell}>
      <nav className={styles.tabs} aria-label="Proof Library sections">{tabs.map((tab) => <button key={tab.id} type="button" aria-pressed={activeTab === tab.id} className={activeTab === tab.id ? styles.activeTab : ''} onClick={() => { setActiveTab(tab.id); setEditing(null); }}>{tab.label}</button>)}</nav>
      <p className={styles.note}>{activeTab === 'review' ? 'Original review text is stored exactly. Any future quoted excerpt must be a contiguous verbatim substring.' : 'Verified facts remain separate from the exact advertising wording approved for use.'}</p>
      {loading ? <p className={styles.empty}>Loading proof records…</p> : loaded ? <>
        {activeTab === 'review' ? <ReviewCsvImport onImported={imported} /> : null}
        <ProofForm key={editing?.id ?? activeTab} type={activeTab} record={editing} onSaved={saved} onCancel={() => setEditing(null)} />
        {error ? <ProofLibraryError>{error}</ProofLibraryError> : null}
        <section className={styles.list} aria-label={activeTab === 'review' ? 'Saved reviews' : 'Saved case studies'}>
          {visible.length ? visible.map((record) => <ProofRecordCard key={record.id} record={record} onEdit={() => setEditing(record)} onToggle={() => void toggle(record)} />) : <p className={styles.empty}>No {activeTab === 'review' ? 'reviews' : 'case studies'} saved yet.</p>}
        </section>
      </> : <div className={styles.empty}><ProofLibraryError>{error || proofLibraryLoadFailureMessage}</ProofLibraryError><button type="button" onClick={() => void load()}>Retry loading Proof Library</button></div>}
    </div>
  );
}
