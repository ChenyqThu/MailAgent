// P3 (task 06-18-custom-ai-harness-agent Phase 3) — Skill enablement: the layer
// that makes the Settings "Skills" toggle REALLY affect the agent, not just hide
// UI. Two effects, both derived from the same (manifest, overrides) pair so the
// UI and the runtime agree:
//
//   1. TOOL filter — a disabled (or unavailable) skill's tools are dropped from
//      the harness catalog (by tool name, using the manifest's skill→tools
//      ownership as the authority). The builtin catalog stays the production
//      path; we just filter it post-build.
//   2. PROMPT fragment — only enabled+available skills' `prompt_fragment` strings
//      are concatenated into `skillFragments`, injected into the stable system
//      prompt (custom_api.buildStableSystemPrompt). A disabled skill injects
//      neither its tools nor its prompt fragment (architecture.md §6.5).
//
// Persistence is CLIENT-side (localStorage): the manifest's `default_enabled` is
// the compile-time seed; the user's per-skill override sits on top. There is no
// backend skill-enabled store (P2 left none) and adding one would bump
// CHAT_DB_VERSION / touch the high-risk manifest cutover — out of P3 scope. The
// override is per-surface (desktop / each remote browser keep their own), which
// is acceptable for a global MVP toggle.
//
// availability ≠ enabled: a KOS-less / notion-agent-CLI-less skill reports
// `availability.available=false` and its tools/fragment are dropped even if the
// user "enabled" it — `effectiveEnabled && available` is the real gate.
//
// Zero Electron/Node import (invariant 1, pnpm build:web) — only the manifest
// types + browser localStorage.

import type { SkillManifest } from './tools/manifest'

/** localStorage key holding the per-skill enabled overrides as a JSON object
 *  `{ [skillName]: boolean }`. Absent skill → fall back to manifest default. */
export const SKILL_OVERRIDES_KEY = 'mailagent.skills.enabled'

/** A skill resolved against the user's overrides — the shape the Settings UI
 *  renders and the runtime filters on. */
export interface ResolvedSkill {
  name: string
  title: string
  description: string
  /** Manifest compile-time seed. */
  defaultEnabled: boolean
  /** availability.available — KOS / notion-agent CLI / etc. preconditions. */
  available: boolean
  /** Human-readable reason when unavailable (else null). */
  unavailableReason: string | null
  /** overrides[name] ?? defaultEnabled — what the user toggled (or the seed). */
  effectiveEnabled: boolean
  /** Tool names this skill owns (manifest authority). */
  toolNames: string[]
  toolCount: number
  /** Union of the skill tools' auth_scopes (for the UI side-effect summary). */
  scopes: string[]
  /** The skill's prompt fragment (injected only when advertised). */
  promptFragment: string
  /** effectiveEnabled && available — the tools+fragment are advertised iff true. */
  advertised: boolean
}

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

/** Set one skill's override + persist. Returns the new map. */
export function setSkillOverride(name: string, enabled: boolean): Record<string, boolean> {
  const next = { ...readSkillOverrides(), [name]: enabled }
  writeSkillOverrides(next)
  return next
}

/** Resolve every manifest skill against the overrides → ResolvedSkill[]. */
export function resolveSkills(
  manifest: SkillManifest,
  overrides: Record<string, boolean>
): ResolvedSkill[] {
  return manifest.skills.map((s) => {
    const effectiveEnabled = overrides[s.name] ?? s.default_enabled
    const available = s.availability.available
    const toolNames = s.tools.map((t) => t.name)
    const scopes = [...new Set(s.tools.flatMap((t) => t.auth_scopes))].sort()
    return {
      name: s.name,
      title: s.title,
      description: s.description,
      defaultEnabled: s.default_enabled,
      available,
      unavailableReason: s.availability.reason ?? null,
      effectiveEnabled,
      toolNames,
      toolCount: toolNames.length,
      scopes,
      promptFragment: s.prompt_fragment,
      advertised: effectiveEnabled && available
    }
  })
}

export interface SkillEnablement {
  /** Tool names to drop from the harness catalog (owned by a non-advertised
   *  skill). Tools not owned by any manifest skill (memory_*, kos_*) never
   *  appear here → core tools are never filtered. */
  disabledToolNames: Set<string>
  /** Concatenated prompt fragments of advertised skills (injected into the
   *  stable system prompt). Empty string = nothing to inject. */
  skillFragments: string
  /** Per-skill resolution (drives the Settings UI). */
  resolved: ResolvedSkill[]
}

/** Compute the tool filter + prompt fragments from a manifest + overrides.
 *  Pure (no I/O) → unit-testable without a live serve-api. */
export function computeSkillEnablement(
  manifest: SkillManifest,
  overrides: Record<string, boolean>
): SkillEnablement {
  const resolved = resolveSkills(manifest, overrides)
  const disabledToolNames = new Set<string>()
  const fragments: string[] = []
  for (const s of resolved) {
    if (s.advertised) {
      const frag = s.promptFragment.trim()
      if (frag.length > 0) fragments.push(frag)
    } else {
      // A non-advertised skill's tools are dropped from the catalog by name.
      for (const name of s.toolNames) disabledToolNames.add(name)
    }
  }
  return { disabledToolNames, skillFragments: fragments.join('\n\n'), resolved }
}
