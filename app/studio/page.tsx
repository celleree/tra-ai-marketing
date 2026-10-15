import { RecoveryView } from '@/components/recovery/recovery-view';
import { isReadOnlyRecovery } from '@/lib/recovery/read-only';
import Link from 'next/link';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';

export default function StudioPage() {
  if (isReadOnlyRecovery()) return <RecoveryView />;
  return <>
    {process.env.NODE_ENV !== 'production' ? <Link href="/studio/video">Open local video intelligence</Link> : null}
    <CreativeGenerator />
  </>;
}
