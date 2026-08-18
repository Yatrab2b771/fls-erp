import { z } from "zod";

const skuSpecSchema = z.object({
  productName: z.string().min(1),
  jar: z.string().optional(),
  wadMm: z.string().optional(),
  scoopMl: z.string().optional(),
  silicaGelGms: z.string().optional(),
  silicaGelQtyNos: z.string().optional(),
  authenticationSticker: z.string().optional(),
  capSticker: z.string().optional(),
  capLockSticker: z.string().optional(),
  neckSleeve: z.string().optional(),
  shrink: z.string().optional(),
  innerPackaging: z.string().optional(),
  leaflet: z.string().optional(),
  corrugatedBoxMm: z.string().optional(),
  packagingSizeNos: z.string().optional(),
  // Anything else the imported sheet had, so nothing is silently dropped.
  extra: z.record(z.string(), z.unknown()).optional(),
});

// One brand ("sheet") with all of its SKU rows, matching how the source
// workbook is naturally grouped after SheetJS parses it client-side.
export const importCatalogSchema = z.object({
  brands: z
    .array(
      z.object({
        brand: z.string().min(1),
        skus: z.array(skuSpecSchema).min(1),
      }),
    )
    .min(1),
});

export type ImportCatalogInput = z.infer<typeof importCatalogSchema>;
