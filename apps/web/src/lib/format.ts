// Shared display formatting — small, presentation-only helpers with no
// business logic, kept separate from the data hooks/types they format.

/** The DB-generated autoincrement employeeId, formatted as a short, readable code — e.g. 7 -> "FLS-0007". */
export function formatEmployeeId(employeeId: number): string {
  return `FLS-${String(employeeId).padStart(4, "0")}`;
}

/** A quantity for display: at most 3 decimals, no float noise (0.5689999999999998 -> 0.569). */
export const fmtQty = (n: number): string => String(Math.round(n * 1000) / 1000);
