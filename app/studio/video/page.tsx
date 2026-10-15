import { notFound } from 'next/navigation';
import { VideoIntelligenceStudio } from '@/components/video-intelligence/video-intelligence-studio';
import { isDurableVideoIntelligenceAvailable } from '@/lib/video/preview-availability';
import { isPreviewAcceptance } from '@/lib/creatives/preview-acceptance';

export default function VideoStudioPage() {
  if (!isDurableVideoIntelligenceAvailable()) notFound();
  return <VideoIntelligenceStudio acceptancePreview={isPreviewAcceptance()} />;
}
