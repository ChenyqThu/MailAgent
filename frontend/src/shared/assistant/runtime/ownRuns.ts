// codex r2 [C] + r3 P1 (task 07-15 harness-chat) — own-run attribution for the settle door.
//
// The gateway stamps every leased /api/ai/chat response with an `x-mailagent-run-id` header
// (the ActiveRunRegistry runId). The AI SDK transport wrapper records the ids of runs its OWN
// RUNTIME INSTANCE started (useMailAgentAiSdkRuntime), and useBackgroundChatRun consults the set
// to tell "our own attached turn just persisted" (the runtime already renders it — a
// settle-reload-remount would be pure disruption) from "a background/other-surface run settled"
// (reload needed).
//
// codex r3 P1 — ownership is scoped to the RUNTIME INSTANCE that actually holds the attached
// stream, NOT the renderer. The r2 shape (a permanent renderer-level Set) leaked ownership across
// keyed remounts: start a run → switch session (the keyed provider unmounts, its stream keeps
// draining server-side) → switch back BEFORE it finishes → the NEW runtime instance saw the probe
// runId as "own", never built a witness, and the persist broadcast was masked → onSettled never
// fired → permanently stale seed. Now each runtime instance registers an owner token for its
// mount lifetime; isOwnRun() is true only while the recording owner is still LIVE. A runtime
// unmount releases liveness (the run degrades to a normal background run for any later mount),
// while runId→owner mappings are kept so a StrictMode effect replay (setup → cleanup → setup of
// the SAME instance, whose ref-held token survives) resurrects ownership instead of mis-releasing
// a mounted runtime's runs.
//
// runIds are gateway-minted UUIDs → globally unique, so module-level maps (shared by every panel
// in the window — exactly right: a popout and the dock share the renderer) suffice.
//
// Bounded: a long-lived window records one id per own turn; cap the map FIFO so it never grows
// unbounded (an evicted id would at worst cause one redundant — idempotent — reload, never a loss).

const MAX_OWN_RUN_IDS = 128

/** Opaque per-runtime-instance ownership token (identity only — hold it in a ref). */
export type OwnRunOwner = object

/** runId → the runtime-instance token whose transport received it. FIFO-capped. */
const runOwners = new Map<string, OwnRunOwner>()

/** Owners whose runtime instance is currently mounted. */
const liveOwners = new Set<OwnRunOwner>()

/** Mark a runtime instance live for the duration of its mount. Returns the release disposer —
 *  call it on unmount (effect cleanup) so the instance's runs stop reading as "own". Safe under
 *  StrictMode's setup→cleanup→setup replay: re-registering the same token restores liveness and
 *  the run mappings were never dropped. */
export function registerOwnRunOwner(owner: OwnRunOwner): () => void {
  liveOwners.add(owner)
  return (): void => {
    liveOwners.delete(owner)
  }
}

/** Record a run id the owner's transport just received on its own /api/ai/chat response. */
export function recordOwnRun(owner: OwnRunOwner, runId: string): void {
  if (!runId) return
  // refresh insertion order so an unlikely re-record keeps the id young
  runOwners.delete(runId)
  runOwners.set(runId, owner)
  while (runOwners.size > MAX_OWN_RUN_IDS) {
    const oldest = runOwners.keys().next().value
    if (oldest === undefined) break
    runOwners.delete(oldest)
  }
}

/** True when the runId belongs to a run whose recording runtime instance is STILL MOUNTED.
 *  After that instance unmounts (session switch / popout close) the run reads as background —
 *  a later mount of the same session must witness + settle it normally (codex r3 P1). */
export function isOwnRun(runId: string | null | undefined): boolean {
  if (runId == null) return false
  const owner = runOwners.get(runId)
  return owner !== undefined && liveOwners.has(owner)
}

/** Test-only reset (module-level state would otherwise leak across vitest cases). */
export function _resetOwnRunsForTest(): void {
  runOwners.clear()
  liveOwners.clear()
}
