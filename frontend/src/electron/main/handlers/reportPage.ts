// codex LOW-1 — report:list pagination clamp, kept in a PURE module (no better-sqlite3 / electron
// import) so it is unit-testable in isolation. The bounds mirror serve-api GET /api/reports exactly
// (limit Query(50, ge=1, le=200); offset Query(0, ge=0)) so the local Electron IPC and the remote
// HTTP transport agree on page shape — a bogus IPC arg can't run an unbounded / negative-offset
// query. Non-integer / absent values fall back to the serve-api defaults (limit 50, offset 0).

export function clampReportPage(opts?: { limit?: number; offset?: number }): {
  limit: number
  offset: number
} {
  const rawLimit = Number.isInteger(opts?.limit) ? (opts!.limit as number) : 50
  const rawOffset = Number.isInteger(opts?.offset) ? (opts!.offset as number) : 0
  return { limit: Math.min(200, Math.max(1, rawLimit)), offset: Math.max(0, rawOffset) }
}
