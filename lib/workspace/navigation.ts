export const WORKSPACE_SECTIONS = ['upload', 'tra-creatives', 'company', 'proof-library', 'reference-images', 'copilot', 'ai-videos', 'discovery'] as const;
export type WorkspaceSection = typeof WORKSPACE_SECTIONS[number];
export function parseWorkspaceSection(value: unknown): WorkspaceSection {
  return typeof value === 'string' && (WORKSPACE_SECTIONS as readonly string[]).includes(value) ? value as WorkspaceSection : 'upload';
}
export function workspaceUrl(current: string, section: WorkspaceSection): string {
  const url = new URL(current);
  url.searchParams.set('workspace', section);
  return url.pathname + url.search + url.hash;
}
