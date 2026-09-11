// Checklist item text lifted verbatim from the client's own BMR-1.docx —
// fixed process definition, same rationale as PRE_PRODUCTION_STAGE_ORDER:
// not user-editable, and the item text/order matters because it has to
// match the paper form people already know. Each checklist has two
// columns — a "first department" (Store for dispensing, Production for
// bulk mfg) and QA — recorded per item in PreProductionChecklistItem /
// CombinedLotChecklistItem respectively. Two separate tables now (see
// schema.prisma), not one table keyed by a `type` enum, since each tier
// only ever has the one checklist that belongs to it.

export interface ChecklistItem {
  key: string;
  label: string;
}

// "1.0 LINE CLEARANCE FOR DISPENSING AREA" — PreProduction's own
// checklist, at the LINE_CLEARANCE stage, Store's column.
export const LINE_CLEARANCE_DISPENSING_ITEMS: ChecklistItem[] = [
  { key: "rm_available_per_bom", label: "Ensure that the raw material available as per bill of material." },
  { key: "material_qc_approved", label: "Ensure that the material approved by quality control." },
  { key: "area_devoid_previous_product", label: "Ensure that the area devoid of remains of the previously dispensed product." },
  { key: "waste_bins_empty_clean", label: "Ensure the waste bins of the area are empty and cleaned." },
  { key: "area_clean_dry", label: "Ensure that the floor, walls, ceiling, doors and window & electrical fixtures clean and dry." },
  { key: "balance_calibrated_cleaned", label: "Ensure that the balance calibrated and cleaned." },
  { key: "utensils_cleaned", label: "Ensure the utensils to be used for dispensing are cleaned." },
];

// "4.0 LINE CLEARANCE FOR BULK MANUFACTURING" — CombinedLot's own
// checklist, at the IPQC stage (per the client's own placement call),
// Production's column instead of Store's, otherwise the same shape.
export const LINE_CLEARANCE_BULK_MFG_ITEMS: ChecklistItem[] = [
  { key: "bpcr_filled_till_dispensing", label: "Ensure that the BPCR available & filled online till dispensing stage." },
  { key: "area_devoid_previous_product_bulk", label: "Ensure that the area devoid of remains of the previously manufactured product. Ensure the waste bins of the area are empty and cleaned." },
  { key: "area_equipment_cleaned_sop", label: "Ensure that area & equipments cleaned as per respective SOP." },
  { key: "area_clean_dry_bulk", label: "Ensure that the floor, walls, ceiling, doors and window & electrical fixtures clean and dry." },
  { key: "balance_calibrated_record", label: "Ensure that the balance calibrated and record completed." },
  { key: "preventive_maintenance", label: "Ensure that the Preventive maintenance is performed as per schedule. Check for label." },
  { key: "temp_rh_within_limits", label: "Check and ensure that the temperature & RH are within limits." },
];

export function preProductionChecklistKeys(): Set<string> {
  return new Set(LINE_CLEARANCE_DISPENSING_ITEMS.map((i) => i.key));
}

export function combinedLotChecklistKeys(): Set<string> {
  return new Set(LINE_CLEARANCE_BULK_MFG_ITEMS.map((i) => i.key));
}
