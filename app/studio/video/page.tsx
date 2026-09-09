import { notFound } from 'next/navigation';
import { VideoIntelligenceStudio } from '@/components/video-intelligence/video-intelligence-studio';
import { isDurableVideoIntelligenceAvailable } from '@/lib/video/preview-availability';

export default function VideoStudioPage() {
  if (!isDurableVideoIntelligenceAvailable()) notFound();
  return <VideoIntelligenceStudio />;
}
