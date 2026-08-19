export const CREATIVE_FORMATS = [
  "problem-solution",
  "simple-headline",
  "statistics-data",
  "comparison-us-vs-them",
  "editorial-magazine",
  "testimonial-review",
  "native-instagram-story",
  "offer-first",
  "faq-objection",
  "reasons-why",
  "before-after",
  "meme-native-social",
  "authority-expert",
  "news-style",
  "contrarian-claim",
] as const;

export type CreativeFormatId = (typeof CREATIVE_FORMATS)[number];

export const CREATIVE_FORMAT_LABELS: Record<CreativeFormatId, string> = {
  "problem-solution": "Problem → solution",
  "simple-headline": "Simple headline",
  "statistics-data": "Statistics / data",
  "comparison-us-vs-them": "Comparison / us-vs-them",
  "editorial-magazine": "Editorial / magazine",
  "testimonial-review": "Testimonial / review",
  "native-instagram-story": "Native Instagram Story",
  "offer-first": "Offer-first",
  "faq-objection": "FAQ / objection",
  "reasons-why": "Reasons why",
  "before-after": "Before / after concept",
  "meme-native-social": "Meme / native social",
  "authority-expert": "Authority / expert",
  "news-style": "News-style",
  "contrarian-claim": "Contrarian claim",
};

export function isCreativeFormat(value: string): value is CreativeFormatId {
  return CREATIVE_FORMATS.includes(value as CreativeFormatId);
}
