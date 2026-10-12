import Link from 'next/link';
import { OperatorWorkspace } from '@/components/auth/operator-workspace';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';
import { isPreviewAcceptance } from '@/lib/creatives/preview-acceptance';

export default function HomePage() {
  return (
    <OperatorWorkspace>
      {process.env.NODE_ENV !== 'production' ? (
        <Link href="/studio/video">Open local video intelligence</Link>
      ) : null}
      <CreativeGenerator acceptancePreview={isPreviewAcceptance()} />
    </OperatorWorkspace>
  );
}
