import express from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import pinoHttp from "pino-http";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./common/lib/logger";
import { env } from "./common/lib/env";
import { RouteError } from "./common/lib/route-error";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";
import { customersRouter } from "./modules/customers/customers.routes";
import { purchaseOrdersRouter } from "./modules/purchase-orders/purchase-orders.routes";
import { batchesRouter } from "./modules/batches/batches.routes";
import { catalogRouter } from "./modules/packaging-bom/catalog.routes";
import { bomPlanRouter } from "./modules/packaging-bom/bom-plan.routes";
import { recipeCatalogRouter } from "./modules/rm-costing/recipe-catalog.routes";
import { rmPlanRouter } from "./modules/rm-costing/rm-plan.routes";
import { inventoryRouter } from "./modules/inventory/inventory.routes";
import { preInventoryRouter } from "./modules/inventory/pre-inventory.routes";
import { dayStoresRouter, plantsRouter } from "./modules/inventory/locations.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { poReadinessRouter } from "./modules/po-readiness/po-readiness.routes";
import { recycleBinRouter } from "./modules/recycle-bin/recycle-bin.routes";

export function createApp() {
  const app = express();

  // Render (and most PaaS hosts) put the app behind a reverse proxy, so
  // the real client IP only reaches us via X-Forwarded-For. Without this,
  // req.ip resolves to the proxy's own IP for every request — which
  // breaks loginRateLimit by bucketing every visitor together under one
  // IP, so one person's repeated attempts can lock out everyone else.
  // `1` trusts exactly one hop (the platform's own proxy), not an
  // arbitrary chain, so a client can't spoof X-Forwarded-For to dodge
  // the limiter.
  app.set("trust proxy", 1);

  // The API and the React app (apps/web, served by Vite in dev / its own
  // static host in prod) are separate origins, so CORS is real here, not
  // vestigial like it was when one Express app served both.
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL ? env.FRONTEND_URL.split(",").map((s) => s.trim()) : true }));
  app.use(express.json());

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers["x-request-id"];
        const id = typeof existing === "string" ? existing : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
    }),
  );

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/customers", customersRouter);
  app.use("/api/purchase-orders", purchaseOrdersRouter);
  app.use("/api/batches", batchesRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/bom", bomPlanRouter);
  app.use("/api/rm-costing", recipeCatalogRouter);
  app.use("/api/rm-costing", rmPlanRouter);
  app.use("/api/inventory", inventoryRouter);
  app.use("/api/inventory/requirements", preInventoryRouter);
  app.use("/api/inventory/day-stores", dayStoresRouter);
  app.use("/api/inventory/plants", plantsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/po-readiness", poReadinessRouter);
  app.use("/api/recycle-bin", recycleBinRouter);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // A RouteError is a validation/conflict failure a handler threw from
    // inside a runSerializable callback (see serializable-transaction.ts)
    // — there's no `res` reachable at the point it's raised, so it
    // carries its own intended status out through next(err) instead.
    // Expected, not a bug, so it's not logged as an error.
    if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });

    req.log?.error({ err }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
