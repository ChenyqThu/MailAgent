// S3 (07-02) — the localStorage per-skill override store, MOVED out of the legacy
// shared/chat/skill_enablement.ts before the legacy engine was deleted. Only the
// TRANSITIONAL fallback survives: the backend agent_config.db is the SSoT for skill
// toggles (GET /agent/skills), and the Settings panel reads this local map once to
// migrate an un-migrated user's prior per-surface toggles, then clears it
// (CustomAiSection). New code should never write here.

const SKILL_OVERRIDES_KEY = 'mailagent.skills.enabled'

/** Read the per-skill overrides map from localStorage. Malformed / unavailable
 *  storage → {} (fall back to manifest defaults; never throws). */
export function readSkillOverrides(): Record<string, boolean> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(SKILL_OVERRIDES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Persist the overrides map. Best-effort (privacy-mode localStorage may throw). */
export function writeSkillOverrides(map: Record<string, boolean>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SKILL_OVERRIDES_KEY, JSON.stringify(map))
  } catch {
    /* localStorage unavailable — in-memory store still drives the current view */
  }
}
