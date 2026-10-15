import type { CreativeImageRouting } from '@/lib/creatives/image-models';

export interface ImageGenerationResult {
  buffer: Buffer;
  prompt: string;
  model: string;
  routing: CreativeImageRouting;
}
