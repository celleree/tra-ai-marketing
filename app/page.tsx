import Link from 'next/link';
import { parseWorkspaceSection } from '@/lib/workspace/navigation';
import { OperatorWorkspace } from '@/components/auth/operator-workspace';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';
import { isPreviewAcceptance } from '@/lib/creatives/preview-acceptance';

export default async function HomePage({ searchParams }: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams ?? {})) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, item);
  }
  return (
    <OperatorWorkspace returnTo={'/' + (query.size ? '?' + query.toString() : '')}>
      {process.env.NODE_ENV !== 'production' ? (
        <Link href="/studio/video">Open local video intelligence</Link>
      ) : null}
      <CreativeGenerator acceptancePreview={isPreviewAcceptance()} initialSection={parseWorkspaceSection(query.get('workspace'))} />
    </OperatorWorkspace>
  );
}
