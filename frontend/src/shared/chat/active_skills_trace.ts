// R7 (task 06-22) — the last-built chat engine's active-skill snapshot, exposed for the
// Phase 0 eval trace recorder. Previously the active_skills_hash was console.debug-only and
// a 32-bit FNV fingerprint; the trace recorder cannot scrape console logs, so the runtime
// now writes the canonical active skill list + a sha256 hash here for it to read.
//
// Module-level (one process → the "current" active set). Zero Electron/Node import.

export interface ActiveSkillsSnapshot {
  /** Canonical (sorted) advertised skill names for the last-built engine. */
  activeSkills: string[]
  /** sha256 hex of the canonical names — the config-snapshot active_skills_hash. */
  activeSkillsHash: string
}

let _snapshot: ActiveSkillsSnapshot | null = null

/** Called by the runtime's buildEngine after it derives the active set for a turn. */
export function setActiveSkillsSnapshot(snapshot: ActiveSkillsSnapshot): void {
  _snapshot = snapshot
}

/** The active-skills snapshot for the last-built chat engine, or null if none built yet.
 *  The Phase 0 trace recorder reads this to stamp `active_skills_hash` reproducibly. */
export function getActiveSkillsSnapshot(): ActiveSkillsSnapshot | null {
  return _snapshot
}
