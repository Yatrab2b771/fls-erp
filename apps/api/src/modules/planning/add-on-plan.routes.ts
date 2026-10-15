import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { calculateAddOn, listAddOnProducts, searchAddOnPlanCandidates, getSkuMaterialAvailability, getRecipeMaterialAvailability } from "./add-on-plan";

export const addOnPlanRouter = Router();

addOnPlanRouter.use(requireAuth, requireRole("PPIC"));

// The page's dropdown: every product with a Packaging BOM and / or an RM formulation
addOnPlanRouter.get("/products", async (_req, res, next) => {
  try {
    res.json(await listAddOnProducts());
  } catch (err) {
    next(err);
  }
});

const calculateSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().trim().min(1).max(300),
  quantity: z.number({ invalid_type_error: "Enter the quantity" }).positive("Quantity must be above zero").max(100_000_000),
  unit: z.enum(["KG", "PACKS"]),
});

// "Can we get this product urgently?": the RM and PM needed for this quantity against live stock. Nothing is saved.
addOnPlanRouter.post("/calculate", validateBody(calculateSchema), async (req, res, next) => {
  try {
    const result = await calculateAddOn(req.body as z.infer<typeof calculateSchema>);
    if (!result) return res.status(404).json({ error: "Customer not found" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

addOnPlanRouter.get("/search", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.json(await searchAddOnPlanCandidates(q));
  } catch (err) {
    next(err);
  }
});

addOnPlanRouter.get("/sku/:id", async (req, res, next) => {
  try {
    const detail = await getSkuMaterialAvailability(req.params.id);
    if (!detail) return res.status(404).json({ error: "No calculated Packaging BOM plan exists yet for this product" });
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

addOnPlanRouter.get("/recipe/:id", async (req, res, next) => {
  try {
    const detail = await getRecipeMaterialAvailability(req.params.id);
    if (!detail) return res.status(404).json({ error: "No calculated RM Costing plan exists yet for this product" });
    res.json(detail);
  } catch (err) {
    next(err);
  }
});
