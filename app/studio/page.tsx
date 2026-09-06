import Link from 'next/link';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';

export default function StudioPage() {
  return <>
    {process.env.NODE_ENV !== 'production' ? <Link href="/studio/video">Open local video intelligence</Link> : null}
    <CreativeGenerator />
  </>;
}
