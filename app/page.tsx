import Link from 'next/link';
import { OperatorWorkspace } from '@/components/auth/operator-workspace';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';

export default function HomePage() {
  return (
    <OperatorWorkspace>
      {process.env.NODE_ENV !== 'production' ? (
        <Link href="/studio/video">Open local video intelligence</Link>
      ) : null}
      <CreativeGenerator />
    </OperatorWorkspace>
  );
}
