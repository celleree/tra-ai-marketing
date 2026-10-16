/** Browser-local selection only; the server workspace remains shared. */
const KEY = 'tax-marketing-studio:reference-selection:v1';
const valid = (id: unknown): id is string => typeof id === 'string' && /^media_[a-f0-9]{32}$/.test(id);
export function readSelectedCompanyReferenceIds(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter(valid))].slice(0, 50) : [];
  } catch { return []; }
}
export function setSelectedCompanyReferenceIds(ids: readonly string[]): void {
  const selected = [...new Set(ids.filter(valid))];
  if (selected.length > 50) throw new Error('Choose at most 50 layout references for this company.');
  localStorage.setItem(KEY, JSON.stringify(selected));
}
