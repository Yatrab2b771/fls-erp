# FLS Mitr

- **[`server/`](server/README.md)** — the real application: Express +
  TypeScript API backed by PostgreSQL/Prisma. Auth & RBAC, Packaging BOM,
  RM Costing, the MPS approval pipeline, and Order Tracking (customer
  onboarding through RM/PM procurement, production, packaging, and
  dispatch) — see `server/README.md` for what's implemented and the full
  endpoint list.
- **`prototypes/`** — the original standalone HTML/PHP mockups each server
  module was ported from. Reference material only, not served by anything;
  kept around so a ported module can be diffed against the behavior it's
  supposed to match. Not part of the running application.
