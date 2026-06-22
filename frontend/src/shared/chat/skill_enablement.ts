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
// Persistence is BACKEND SSoT (Phase -1 / PR5): the per-skill enable override lives
// in agent_config.db and reaches the runtime via `/chat/config`.skillOverrides; the
// manifest's `default_enabled` is the compile-time seed underneath it. The localStorage
// helpers below (readSkillOverrides / writeSkillOverrides / setSkillOverride +
// SKILL_OVERRIDES_KEY) are a TRANSITIONAL migration fallback only — they let an
// un-migrated client keep applying its prior per-surface toggles until the Settings
// panel pushes them to the backend (migrateLocalSkillOverrides) — and should be removed
// once old clients have migrated. Do NOT treat localStorage as the source of truth.
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

// Tool names that collide ACROSS skills with different builtin semantics, so they
// must NOT be auto-dropped by a skill toggle. The builtin `email_search` is a
// metadata filter (subject/sender/date/flags — the agent's primary "find emails"
// tool) while the manifest `search` skill's `email_search` is FTS body search
// (documented in tools/manifest.ts; the P2 manifest cutover excluded it for the
// same reason). Dropping the builtin metadata search because the FTS "search"
// skill was toggled off is collateral damage the user didn't intend.
const COLLISION_EXEMPT_TOOL_NAMES = new Set(['email_search'])

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
  // R2 (GPT-5.5 review, HIGH) — a tool name is dropped ONLY when NO advertised skill
  // still owns it. The old rule ("a non-advertised skill disables its tool names")
  // was safe when tool names were unique per skill, but Phase -1 installed
  // existing-tool skills can ALIAS a builtin read tool name (email_get, report_get,
  // email_body, …). Disabling such an alias skill would then drop the builtin tool
  // from the harness catalog even though the builtin Email/Report skill is still
  // enabled — silent capability loss. Partition the names first; an advertised owner
  // always wins. (email_search stays collision-exempt for the separate
  // builtin-metadata vs manifest-FTS same-name clash.)
  const advertisedToolNames = new Set<string>()
  const nonAdvertisedToolNames = new Set<string>()
  const fragments: string[] = []
  for (const s of resolved) {
    if (s.advertised) {
      for (const name of s.toolNames) advertisedToolNames.add(name)
      const frag = s.promptFragment.trim()
      if (frag.length > 0) fragments.push(frag)
    } else {
      for (const name of s.toolNames) nonAdvertisedToolNames.add(name)
    }
  }
  const disabledToolNames = new Set<string>()
  for (const name of nonAdvertisedToolNames) {
    if (!advertisedToolNames.has(name) && !COLLISION_EXEMPT_TOOL_NAMES.has(name)) {
      disabledToolNames.add(name)
    }
  }
  return { disabledToolNames, skillFragments: fragments.join('\n\n'), resolved }
}

/** R6 (GPT-5.5 review) — resolve the effective backend skill overrides for a /chat/config
 *  snapshot, failing CLOSED on a store blip. When the override store was unavailable
 *  (`available === false`, so the snapshot's overrides are {} for "store down", NOT "user
 *  cleared toggles"), reuse the last-known-good map instead of {} — otherwise a transient
 *  blip would broaden to manifest defaults and silently re-enable a user-DISABLED skill.
 *  `lastGood` is only advanced on a healthy read. Pure → unit-testable. */
export function resolveBackendOverrides(
  snapshotOverrides: Record<string, boolean> | undefined,
  available: boolean,
  lastGood: Record<string, boolean> | null
): { overrides: Record<string, boolean>; lastGood: Record<string, boolean> | null } {
  if (available === false) {
    return { overrides: lastGood ?? {}, lastGood } // fail-closed: reuse LKG, don't advance it
  }
  const fresh = snapshotOverrides ?? {}
  return { overrides: fresh, lastGood: fresh }
}

/** PR7 — extract `@skill` mentions from a chat message → lowercase skill-name tokens
 *  (e.g. "ping @calendar about @report" → ["calendar", "report"]). The runtime
 *  force-activates these for the session's scope. Non-skill tokens are harmless: an
 *  override for a name no skill owns is ignored by computeSkillEnablement, and an
 *  unavailable skill is still gated by `advertised = enabled && available`. Deduped.
 *  Pure → unit-testable.
 *
 *  R3 (GPT-5.5 review Q5) — the `@` must NOT be preceded by an identifier char
 *  ([A-Za-z0-9._-]); that rejects email addresses ("user@example.com" → no match) while
 *  ALLOWING a mention after CJK text or punctuation ("请@report", "，@calendar") which the
 *  old `(?:^|[\s(])@` boundary missed. Negative lookbehind is supported in all the V8
 *  runtimes this ships to (Electron / browsers / Node ≥18 vitest). */
export function parseSkillMentions(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const out = new Set<string>()
  const re = /(?<![A-Za-z0-9._-])@([a-z][a-z0-9_-]{0,40})/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.add(m[1].toLowerCase())
  return [...out]
}

/** R7 (GPT-5.5 review) — the canonical ACTIVE (advertised = enabled ∧ available) skill
 *  names under the given manifest + overrides, sorted. This is the reproducibility key the
 *  Phase 0 eval trace records. Computed client-side because the active set depends on the
 *  same `advertised` gate + collision-exempt logic the runtime uses (and the per-turn
 *  @mention overlay merged into `overrides`). Pure → unit-testable. */
export function computeActiveSkillNames(
  manifest: SkillManifest,
  overrides: Record<string, boolean>
): string[] {
  return resolveSkills(manifest, overrides)
    .filter((s) => s.advertised)
    .map((s) => s.name)
    .sort()
}

/** R7 — SHA-256 hex of a string via Web Crypto (async). Used for the `active_skills_hash`
 *  trace key (replacing the old 32-bit FNV fingerprint — a crypto digest is the right
 *  strength for an eval reproducibility key). Available in all the V8 runtimes this ships
 *  to (Electron / browsers / Node ≥18 vitest). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
