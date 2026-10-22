export type MaterialKind = "RM" | "PM" | "OTHER";

/** What kind of material an item is, as the screens say it. "Other" is anything that is neither raw nor packaging material (gloves, masks, cleaning material ...). */
export const MATERIAL_KIND_NAME: Record<MaterialKind, string> = { RM: "Raw Material", PM: "Packaging Material", OTHER: "Other" };

export const materialKindName = (category: string | null | undefined): string => MATERIAL_KIND_NAME[category as MaterialKind] ?? MATERIAL_KIND_NAME.PM;
