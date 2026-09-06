import { notFound } from 'next/navigation';
import { VideoIntelligenceStudio } from '@/components/video-intelligence/video-intelligence-studio';

export default function VideoStudioPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <VideoIntelligenceStudio />;
}
