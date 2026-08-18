import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { createCustomerSchema, updateCustomerSchema, type CreateCustomerInput, type UpdateCustomerInput } from "./customers.schemas";

export const customersRouter = Router();

customersRouter.use(requireAuth);

// Directory read is open to any authenticated user — everyone in the
// order flow needs to pick a customer; only BD/Admin write.
customersRouter.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, customers] = await Promise.all([
      prisma.customer.count(),
      prisma.customer.findMany({ orderBy: { companyName: "asc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(customers);
  } catch (err) {
    next(err);
  }
});

customersRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

customersRouter.post("/", requireRole("BD"), validateBody(createCustomerSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreateCustomerInput;
    const customer = await prisma.customer.create({ data: { ...data, createdById: req.user!.id } });

    await recordAudit({ actorId: req.user!.id, action: "customer.created", entityType: "Customer", entityId: customer.id });

    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
});

customersRouter.patch("/:id", requireRole("BD"), validateBody(updateCustomerSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Customer not found" });

    const data = req.body as UpdateCustomerInput;
    const updated = await prisma.customer.update({ where: { id: req.params.id }, data });

    await recordAudit({ actorId: req.user!.id, action: "customer.updated", entityType: "Customer", entityId: updated.id });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});
