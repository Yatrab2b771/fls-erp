import { Router } from "express";
import { requireAuth, requireRole } from "../../common/middleware/auth";
import { searchAddOnPlanCandidates, getSkuMaterialAvailability, getRecipeMaterialAvailability } from "./add-on-plan";

export const addOnPlanRouter = Router();

addOnPlanRouter.use(requireAuth, requireRole("PPIC"));

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
