export const CREATIVE_CATEGORIES = [
  "customer-problems",
  "desired-outcomes",
  "objections",
  "testimonials-proof",
  "statistics",
  "comparisons",
  "price-offer-positioning",
  "feature-led",
  "emotional",
  "educational",
  "aspirational-lifestyle",
  "curiosity",
  "urgency",
  "before-after",
  "customer-personas",
] as const;

export type CreativeCategoryId = (typeof CREATIVE_CATEGORIES)[number];

export const CREATIVE_CATEGORY_LABELS: Record<CreativeCategoryId, string> = {
  "customer-problems": "Customer problems",
  "desired-outcomes": "Desired outcomes",
  objections: "Objections",
  "testimonials-proof": "Testimonials / proof",
  statistics: "Statistics",
  comparisons: "Comparisons",
  "price-offer-positioning": "Price / offer positioning",
  "feature-led": "Feature-led",
  emotional: "Emotional angles",
  educational: "Educational angles",
  "aspirational-lifestyle": "Aspirational / lifestyle",
  curiosity: "Curiosity",
  urgency: "Urgency",
  "before-after": "Before / after",
  "customer-personas": "Customer personas",
};

export function isCreativeCategory(value: string): value is CreativeCategoryId {
  return CREATIVE_CATEGORIES.includes(value as CreativeCategoryId);
}
