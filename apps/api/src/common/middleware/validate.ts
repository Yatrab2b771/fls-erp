import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

/** Parses+validates req.body against schema; on success reassigns req.body to the parsed/defaulted value. */
export function validateBody(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    }
    req.body = result.data;
    next();
  };
}
