// PR7 (task 06-22) — per-session @mention skill activation.
//
// When the user writes `@calendar` (or @report / @email / any skill name) in a chat
// message, that skill is force-ACTIVATED for the rest of the session — an explicit
// override on top of the default auto-selection + the backend enable state. The default
// stays "the agent picks skills automatically"; @mention is the opt-in escape hatch.
//
// Session-scoped: the activation is additive (a mention sticks for the session) and is
// cleared on a new session / surface switch. A module-level zustand store keeps it
// reactive for the chip UI; `getActivatedSkillOverrides()` is a non-React getter so the
// shared runtime's buildEngine can fold it into the override map (force-on = true).
//
// A force-on for a name no skill owns is a harmless no-op (computeSkillEnablement ignores
// it) and a force-on for an UNAVAILABLE skill still won't advertise it (the `advertised =
// enabled && available` gate holds) — so @mention can never bypass availability.

import { create } from 'zustand'

import { parseSkillMentions } from '../chat/skill_enablement'

interface SkillActivationStore {
  /** Skill names force-activated for the current session (sorted, deduped). */
  activated: string[]
  /** Additively union new mentions into the set. No-op if all already present. */
  activate: (names: string[]) => void
  /** Remove one activation (the chip's × affordance). No-op if absent. */
  deactivate: (name: string) => void
  /** Clear all session activations (new session / surface switch). */
  clear: () => void
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export const useSkillActivation = create<SkillActivationStore>((set) => ({
  activated: [],
  activate: (names) =>
    set((s) => {
      const next = Array.from(new Set([...s.activated, ...names])).sort()
      return sameList(next, s.activated) ? s : { activated: next }
    }),
  deactivate: (name) =>
    set((s) => {
      const next = s.activated.filter((n) => n !== name)
      return sameList(next, s.activated) ? s : { activated: next }
    }),
  clear: () => set((s) => (s.activated.length === 0 ? s : { activated: [] }))
}))

/** Non-React getter for the shared runtime (buildEngine): the session activation as a
 *  force-on override map `{ name: true }`. Empty {} when nothing is mentioned. */
export function getActivatedSkillOverrides(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const n of useSkillActivation.getState().activated) out[n] = true
  return out
}

/** PR7 — parse `@skill` mentions out of an outgoing message and force-activate them for
 *  the session. Call this in a chat send() BEFORE chat.start(): on the first turn the
 *  engine isn't built yet so it picks the activation up for free; on a later turn the
 *  newly-activated set differs, so we invalidate the cached engine (via `onActivated`)
 *  and the next start() rebuilds with the mentioned skill advertised. No mentions / no
 *  change → no invalidation (zero cost). */
export function applySkillMentions(text: string, onActivated: () => void): void {
  const names = parseSkillMentions(text)
  if (names.length === 0) return
  const before = useSkillActivation.getState().activated.length
  useSkillActivation.getState().activate(names)
  if (useSkillActivation.getState().activated.length !== before) onActivated()
}
