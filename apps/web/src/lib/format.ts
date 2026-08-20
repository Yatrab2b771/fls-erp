// Shared display formatting — small, presentation-only helpers with no
// business logic, kept separate from the data hooks/types they format.

/** The DB-generated autoincrement employeeId, formatted as a short, readable code — e.g. 7 -> "FLS-0007". */
export function formatEmployeeId(employeeId: number): string {
  return `FLS-${String(employeeId).padStart(4, "0")}`;
}
