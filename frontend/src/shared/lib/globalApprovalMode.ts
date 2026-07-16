// 07-16 approval-mode switcher — renderer-side store of the OWNER-GLOBAL chat approval mode.
//
// Unlike the legacy per-origin localStorage approvalMode (approvalMode.ts, the Manual-only
// 'always'|'auto-reversible' preference), this mode is persisted in the backend agent_config.db
// (owner_settings row) via serve-api, so the desktop app, the Cmd+O popout AND the remote web
// (mail.chenge.ink/app) all read/write ONE value that survives restarts and applies to every new
// session. The gateway resolves it server-side per run (chatRun.ts) — this module is UI state
// only: the chip/menu render from here, but no request body ever carries the global mode.
//
// 🔴 TRUTH DISCIPLINE (codex r1 P1-1/P1-2 rework + r2 P1-a/P1-b rework):
//   - `mode` is only ever a SERVER-CONFIRMED value, or null = unknown. ANY read failure — first
//     read OR a refresh of an already-confirmed mode (focus after another window switched it) —
//     drops to an explicit unknown/warning chip and schedules a retry; the store never keeps
//     impersonating a stale value while the persisted mode could be bypass. Window focus /
//     visibilitychange re-GET, which also converges cross-window / remote-web changes.
//   - requests are EPOCH-managed, not gated on an in-flight boolean: every refresh demand issues
//     a NEW GET immediately (bumping the epoch — only the LATEST request may converge the store;
//     older responses are discarded on arrival). A GET additionally times out after
//     APPROVAL_MODE_GET_TIMEOUT_MS, so a permanently-hanging transport can never wedge the store:
//     the timeout is a read failure (unknown + retry) and the eventual straggler settle is
//     swallowed by the already-settled race.
//   - writes are PESSIMISTIC and serialized: the displayed mode changes only when the PUT returns
//     the server-canonical value; while a PUT is in flight `saving` is true (pickers disable
//     switching) and refreshes are skipped. The PUT races the SAME hard timeout as a GET
//     (codex r3): a hanging PUT counts as failed/indeterminate — otherwise `saving` would stay
//     true forever and gate every focus/retry refresh (a permanent wedge remount can't undo,
//     since the store is module-level). Any failed/indeterminate/timed-out PUT drops to unknown
//     and immediately re-GETs to converge (guaranteed to actually fire — no in-flight gate); the
//     straggler's eventual settle is swallowed by the already-settled race.
//
// Module-level store + useSyncExternalStore (approvalMode.ts idiom): all mounted pickers +
// the Settings AiTab stay in sync within a window; cross-window sync is focus-refresh grained.

import { useCallback, useEffect, useSyncExternalStore } from 'react'

import type { ChatApi, GlobalApprovalMode } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'

export type { GlobalApprovalMode }

export const DEFAULT_GLOBAL_APPROVAL_MODE: GlobalApprovalMode = 'manual'

/** Retry interval while the mode is unknown (a GET failed / timed out). Focus/visibility also
 *  re-GETs immediately — this timer is the backstop for an unfocused window. */
export const APPROVAL_MODE_RETRY_MS = 15_000
/** Per-request deadline for BOTH transport legs (GET: codex r2 P1-b; PUT: codex r3): past it the
 *  request counts as FAILED even if the transport never settles — a hanging request must not
 *  wedge the store (a hung PUT would pin `saving` and gate every refresh), and the follow-up
 *  GETs obsolete it (epoch). */
export const APPROVAL_MODE_GET_TIMEOUT_MS = 10_000
/** Focus + visibilitychange often fire together — after a recent successful read of a confirmed
 *  mode, refreshes within this window are not repeated. */
const REFRESH_THROTTLE_MS = 1_000

export interface GlobalApprovalModeState {
  /** The server-confirmed mode, or null = UNKNOWN (first GET unresolved / all reads failed /
   *  indeterminate PUT). The UI renders null as an explicit warning state, never as Manual. */
  mode: GlobalApprovalMode | null
  /** A PUT is in flight — mutations are serialized; pickers disable switching. */
  saving: boolean
}

let state: GlobalApprovalModeState = { mode: null, saving: false }
/** The chat api face of the most recent hook mount — used by focus/retry refreshes. */
let chatApi: ChatApi | undefined
let lastFetchOkAt = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped by every issued GET and every setMode — the single request-ordering authority
 *  (codex r2 P1-b, replacing the old in-flight boolean gate): only the request holding the
 *  CURRENT epoch may converge the store. A GET that was already in flight when a PUT (or a newer
 *  GET) started settles with a stale epoch and is DISCARDED, so it can never clobber the newer
 *  canonical result — and nothing ever WAITS on it either. */
let epoch = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function setState(next: GlobalApprovalModeState): void {
  if (next.mode === state.mode && next.saving === state.saving) return
  state = next
  emit()
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleRetry(): void {
  if (retryTimer !== null || listeners.size === 0) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void refreshApprovalMode()
  }, APPROVAL_MODE_RETRY_MS)
}

/** GET the persisted mode and converge the store on the server truth. Defensive on a PARTIAL
 *  api face (component-test mocks / degraded ElectronApi): missing method → stay unknown, never
 *  throw. Skipped while a PUT is in flight (the PUT converges on its own canonical response) —
 *  but NEVER skipped because an older GET is still pending: every demand issues a fresh request
 *  that takes over the epoch (codex r2 P1-b), and each request races a hard timeout so a hanging
 *  transport cannot wedge the store. */
async function refreshApprovalMode(): Promise<void> {
  const chat = chatApi
  if (typeof chat?.getApprovalMode !== 'function') return
  if (state.saving) return
  if (state.mode !== null && Date.now() - lastFetchOkAt < REFRESH_THROTTLE_MS) return
  epoch += 1
  const startEpoch = epoch
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  try {
    const mode = await Promise.race([
      chat.getApprovalMode(),
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error('approval-mode GET timed out')),
          APPROVAL_MODE_GET_TIMEOUT_MS
        )
      })
    ])
    if (epoch !== startEpoch) return // a PUT / newer GET took over — its result wins
    lastFetchOkAt = Date.now()
    clearRetry()
    setState({ mode, saving: state.saving })
  } catch {
    // 🔴 truth discipline (codex r2 P1-a): a CURRENT-epoch read failure/timeout always drops to
    // unknown — even over a previously confirmed mode (another window may have switched it; the
    // old value must not be impersonated) — and always keeps the retry loop alive. A stale-epoch
    // failure is ignored — the newer request owns convergence then.
    if (epoch !== startEpoch) return
    setState({ mode: null, saving: state.saving })
    scheduleRetry()
  } finally {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer)
  }
}

/** Focus / visibility → re-GET (cross-window + remote-web staleness fix, codex r1 P1-1). */
function onWindowFocus(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  void refreshApprovalMode()
}

function subscribe(onChange: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onWindowFocus)
  }
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) {
      clearRetry()
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onWindowFocus)
        document.removeEventListener('visibilitychange', onWindowFocus)
      }
    }
  }
}

/** PESSIMISTIC, SERIALIZED mode switch (codex r1 P1-2): the displayed mode does not change until
 *  the PUT returns the server-canonical value; a second call while saving returns false without
 *  touching state (pickers disable switching while `saving`). The PUT races the shared hard
 *  timeout (codex r3) — a never-settling PUT must not pin `saving` forever and gate every
 *  focus/retry refresh. On failure OR timeout the confirmed mode is UNKNOWN (an indeterminate
 *  PUT may or may not have persisted) → drop to null + re-GET. */
async function setModeInternal(next: GlobalApprovalMode): Promise<boolean> {
  const chat = chatApi
  if (typeof chat?.setApprovalMode !== 'function') return false
  if (state.saving) return false
  if (state.mode === next) return true
  epoch += 1
  clearRetry()
  setState({ mode: state.mode, saving: true })
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  try {
    const canonical = await Promise.race([
      chat.setApprovalMode(next),
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error('approval-mode PUT timed out')),
          APPROVAL_MODE_GET_TIMEOUT_MS
        )
      })
    ])
    lastFetchOkAt = Date.now()
    setState({ mode: canonical, saving: false })
    return true
  } catch {
    // failed OR timed-out PUT — both are indeterminate (it may or may not have persisted). The
    // straggler's late settle is swallowed by the already-settled race (both arms have reactions
    // attached — no unhandled rejection), mirroring the GET leg.
    setState({ mode: null, saving: false })
    scheduleRetry() // backstop for a partial api face (missing GET method) — else the re-GET owns it
    // guaranteed to actually issue a GET (codex r2 P1-b): saving is already false, mode is null
    // (no throttle), and there is no in-flight gate — an old hanging GET is simply obsoleted.
    void refreshApprovalMode()
    return false
  } finally {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer)
  }
}

/** test-only — reset the module store between tests (mounted subscribers stay registered). */
export function __resetGlobalApprovalModeForTests(): void {
  state = { mode: null, saving: false }
  chatApi = undefined
  lastFetchOkAt = 0
  epoch = 0
  clearRetry()
}

/**
 * The owner-global chat approval mode + its setter. `mode` is null while unknown (the picker
 * renders a warning state); `saving` is true while a PUT is in flight (pickers disable
 * switching); `setMode` resolves true only after the server confirmed the switch. The gateway
 * hot-reads the persisted value per run (short TTL), so a successful switch reaches the next
 * turn within seconds without restart.
 */
export function useGlobalApprovalMode(): {
  mode: GlobalApprovalMode | null
  saving: boolean
  setMode: (mode: GlobalApprovalMode) => Promise<boolean>
} {
  const api = useMailApi()
  const snap = useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
  useEffect(() => {
    chatApi = api.chat
    void refreshApprovalMode()
  }, [api])
  const setMode = useCallback(
    async (next: GlobalApprovalMode): Promise<boolean> => {
      chatApi = api.chat
      return setModeInternal(next)
    },
    [api]
  )
  return { mode: snap.mode, saving: snap.saving, setMode }
}
