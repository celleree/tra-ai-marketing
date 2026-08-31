import type { GeneratedCreative } from '@/lib/creatives/generated';

type ApplyBrandLogo = (
  creatives: GeneratedCreative[],
  logoUrl: string
) => Promise<GeneratedCreative[]>;

export const completeProgressiveCreative = async ({
  creative,
  logoUrl,
  applyBrandLogo,
  persist,
}: {
  creative: GeneratedCreative;
  logoUrl?: string;
  applyBrandLogo: ApplyBrandLogo;
  persist: (creative: GeneratedCreative) => Promise<void>;
}) => {
  let completedCreative = creative;
  if (logoUrl) {
    const [brandedCreative] = await applyBrandLogo([creative], logoUrl);
    if (!brandedCreative) {
      throw new Error('The branded creative could not be prepared.');
    }
    completedCreative = brandedCreative;
  }

  await persist(completedCreative);
  return completedCreative;
};

export const insertCreativeByIndex = (
  creatives: GeneratedCreative[],
  creative: GeneratedCreative
) => [...creatives, creative].sort((a, b) => a.index - b.index);
