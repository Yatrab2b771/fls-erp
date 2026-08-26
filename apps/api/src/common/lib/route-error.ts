// A validation/conflict failure discovered *inside* a runSerializable
// callback (see serializable-transaction.ts), where the usual
// `return res.status(...).json(...)` isn't reachable — the callback can
// only return the transaction's result or throw. Throwing this instead
// of a plain Error lets the route handler's catch block recover the
// intended HTTP status once the transaction unwinds, rather than every
// such failure falling through to the generic 500 handler.
export class RouteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
