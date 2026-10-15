import { expect, it } from 'vitest';
import { parseWorkspaceSection, workspaceUrl } from '@/lib/workspace/navigation';
it('accepts only known bookmarks and preserves unrelated URL state', () => {
  for (const value of ['copilot', 'ai-videos', 'discovery']) expect(parseWorkspaceSection(value)).toBe(value);
  for (const value of [null, [], 'constructor', 'unknown']) expect(parseWorkspaceSection(value)).toBe('upload');
  expect(workspaceUrl('https://example.test/?other=keep#saved', 'discovery')).toBe('/?other=keep&workspace=discovery#saved');
});
