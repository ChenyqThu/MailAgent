// Sprint 7 ship-review (opus MEDIUM #1 carry-forward) — extracted from
// `handlers/settings.ts` into a shared lib so `db.ts:resolveDbPath()` and
// the IPC sanitizer both consume the same predicate. Without this, the
// sanitizer's gate would be dead code: the renderer never reads `dbPath`
// through `email:*` handlers, so the only path that actually opens
// `better-sqlite3.Database(p)` from `db.ts` could bypass validation.
//
// Sprint 8 §2.2 wires `settingsDbPathOverride()` into `resolveDbPath()`
// using this predicate so the user's chosen DB path runs through the
// same `isSafeUserPath()` rules regardless of whether it arrives via
// IPC write or via direct file-backed read.

import { isAbsolute, normalize } from 'path'

/**
 * Reject empty / relative / `..`-containing paths. Inspects the RAW
 * string for `..` segments BEFORE normalization, because
 * `path.normalize('/a/../etc/passwd')` collapses the `..` away.
 */
export function isSafeUserPath(value: string): boolean {
  if (value.length === 0) return false
  if (!isAbsolute(value)) return false
  const rawSegments = value.split(/[/\\]/).filter(Boolean)
  if (rawSegments.includes('..')) return false
  const normalized = normalize(value)
  if (!isAbsolute(normalized)) return false
  return true
}
