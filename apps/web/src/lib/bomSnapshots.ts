// Shapes of the snapshots stored with each BOM version (see bom-versions.ts on the API).

export interface PmSnapshotShape {
  header: { productCode?: string | null; packSize?: string | null; packingConfig?: string | null; batchPacks?: number | null };
  components: {
    type: string;
    quantity?: number | null;
    unit: string;
    pmCode?: string | null;
    pmItemId?: string | null;
    overagePct?: number | null;
    spec?: string | null;
    make?: string | null;
    packingLevel?: string | null;
  }[];
}

export interface RmSnapshotShape {
  kind?: "PER_KG" | "PER_UNIT";
  productCode?: string | null;
  versionLabel?: string | null;
  batchSize?: number | null;
  avgUnitWeightMg?: number | null;
  ingredients: { name: string; brand: string; itemCode?: string; gPerServing: number; proteinPct: number; uom?: string }[];
}
