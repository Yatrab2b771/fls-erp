// The fixed lists BD picks from on a lead. They come from the Prospect Funnel sheet; the web screens carry the same lists (apps/web/src/lib/leadHooks.ts).

export const CUSTOMER_TYPES = ["D2C", "Exports", "Distribution", "MLM", "Medical", "Sports", "Others"] as const;
export const PRODUCT_FORMATS = ["Gummies", "Bars", "Capsules", "Tablets", "Omega", "Liquid", "Soft gel", "Powder", "Others"] as const;
export const POWDER_TYPES = ["Creatine", "Protein", "Yeast", "Clear", "Meal / Soya shakes", "Whey", "Others"] as const;
export const LEAD_SOURCES = ["Referral", "LinkedIn", "Website", "E-com platforms", "Paid campaigns", "Medical platforms", "Regional brands"] as const;

export const LEAD_STATUSES = ["DISCUSSION", "SAMPLING", "COLD", "WARM", "HOT", "HOLD", "DROPPED", "CONVERTED"] as const;
export type LeadStatusName = (typeof LEAD_STATUSES)[number];

/** A lead that is over (nothing left to follow up). */
export const CLOSED_STATUSES: LeadStatusName[] = ["DROPPED", "CONVERTED"];

/** The visiting-card categories (businessCardHooks CARD_CATEGORIES) as the lead's product formats. */
export const CARD_CATEGORY_TO_FORMAT: Record<string, (typeof PRODUCT_FORMATS)[number]> = {
  Bar: "Bars",
  Gummy: "Gummies",
  Powder: "Powder",
  Liquid: "Liquid",
  Tablet: "Tablets",
  Capsule: "Capsules",
};
