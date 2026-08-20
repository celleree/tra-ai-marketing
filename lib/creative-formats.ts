export const CREATIVE_FORMATS = [
  "direct-response",
  "proof",
  "educational",
  "comparison-transformation",
  "native-social",
] as const;

export type CreativeFormatId = (typeof CREATIVE_FORMATS)[number];

export const CREATIVE_FORMAT_LABELS: Record<CreativeFormatId, string> = {
  "direct-response": "Direct Response",
  proof: "Proof",
  educational: "Educational",
  "comparison-transformation": "Comparison / Transformation",
  "native-social": "Native Social",
};

export function isCreativeFormat(value: string): value is CreativeFormatId {
  return CREATIVE_FORMATS.includes(value as CreativeFormatId);
}
