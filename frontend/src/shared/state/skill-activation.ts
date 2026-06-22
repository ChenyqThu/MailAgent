// PR7 / R3 (task 06-22) — per-SCOPE @mention skill activation.
//
// When the user writes `@calendar` (or @report / @email / any skill name) in a chat
// message, that skill is force-ACTIVATED for the rest of that conversation — an explicit
// override on top of the default auto-selection + the backend enable state. The default
// stays "the agent picks skills automatically"; @mention is the opt-in escape hatch.
//
// R3 (GPT-5.5 review, HIGH) — the activation is keyed by a SCOPE KEY, not a single global
// list. The Email Chat surface and the Cmd+O General Agent dialog can be mounted at once
// and share one ChatApi runtime; a global list would leak a `@report` typed in General
// into Email Chat (its tools + chip), and one email's mention into another email's turn.
// Scope keys namespace them: `email:<emailId>:<backendKind>` and `general:<sessionId>`.
// The runtime never reads this store directly — the hook threads the active scope's names
// into `ChatStartOpts.activatedSkills`, so the engine advertises a mention only for the
// turn whose scope owns it.
//
// A force-on for a name no skill owns is a harmless no-op (computeSkillEnablement ignores
// it) and a force-on for an UNAVAILABLE skill still won't advertise it (the `advertised =
// enabled && available` gate holds) — so @mention can never bypass availability.

import { create } from 'zustand'

import { parseSkillMentions } from '../chat/skill_enablement'

/** Stable empty array so the `useActivatedSkills` selector returns a referentially-stable
 *  value for an absent scope (zustand's Object.is equality → no spurious re-render). */
const EMPTY: readonly string[] = Object.freeze([])

interface SkillActivationStore {
  /** scopeKey → skill names force-activated for that scope (sorted, deduped). */
  byScope: Record<string, string[]>
  /** Additively union new mentions into a scope's set. No-op if all already present. */
  activate: (scopeKey: string, names: string[]) => void
  /** Remove one activation from a scope (the chip's × affordance). No-op if absent. */
  deactivate: (scopeKey: string, name: string) => void
  /** Drop a scope's whole activation set (new session for that scope). No-op if absent. */
  clearScope: (scopeKey: string) => void
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export const useSkillActivation = create<SkillActivationStore>((set) => ({
  byScope: {},
  activate: (scopeKey, names) =>
    set((s) => {
      const cur = s.byScope[scopeKey] ?? []
      const next = Array.from(new Set([...cur, ...names])).sort()
      return sameList(next, cur) ? s : { byScope: { ...s.byScope, [scopeKey]: next } }
    }),
  deactivate: (scopeKey, name) =>
    set((s) => {
      const cur = s.byScope[scopeKey]
      if (!cur || !cur.includes(name)) return s
      return { byScope: { ...s.byScope, [scopeKey]: cur.filter((n) => n !== name) } }
    }),
  clearScope: (scopeKey) =>
    set((s) => {
      if (!(scopeKey in s.byScope)) return s
      const next = { ...s.byScope }
      delete next[scopeKey]
      return { byScope: next }
    })
}))

/** Non-React getter for the hook: the activation names for a scope. The hook threads
 *  these straight into `chat.start({ activatedSkills })`, so the shared runtime folds the
 *  force-on overrides for THIS turn's scope only (no global read). Empty [] when nothing
 *  is mentioned for the scope. */
export function getActivatedSkillNames(scopeKey: string): string[] {
  return useSkillActivation.getState().byScope[scopeKey] ?? []
}

/** Reactive selector for the chip UI: the activation names for the given scope. */
export function useActivatedSkills(scopeKey: string): readonly string[] {
  return useSkillActivation((s) => s.byScope[scopeKey] ?? EMPTY)
}

/** Parse `@skill` mentions out of an outgoing message and force-activate them for the
 *  given scope. Returns the scope's FULL activation list after applying, so the caller
 *  can thread it straight into `chat.start({ activatedSkills })`. Call this in a chat
 *  send() BEFORE chat.start(): the runtime compares the threaded list to the engine it
 *  last built and rebuilds only when it changed (no mentions / no change → zero cost). */
export function applySkillMentions(scopeKey: string, text: string): string[] {
  const names = parseSkillMentions(text)
  if (names.length > 0) useSkillActivation.getState().activate(scopeKey, names)
  return getActivatedSkillNames(scopeKey)
}
