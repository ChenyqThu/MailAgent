// Sprint 9 §2.1 — Island connection probe.
//
// ISLAND-PLUGIN.md §4.5 originally specifies a per-envelope reconnect QUEUE
// on the Python plugin side because mail-flow events (MailReceived /
// LLMReviewed / MailCompleted) carry user-facing meaning if delivered late.
// The Electron side only emits *ephemeral* envelopes (appearance change /
// AI draft 3-phase): a stale theme-change is meaningless, a stale draft-
// stream chunk is even worse. So we skip the queue and only run a *probe*
// — every `PROBE_INTERVAL_MS` we fs.existsSync(socketPath) and fire a Ping
// envelope to confirm the peer accepts our provider. The result feeds the
// `IslandStatus` zustand store via the supplied broadcast callback.
//
// The probe loop is also how dev mode degrades gracefully: in `is.dev`, the
// developer almost certainly doesn't have ping-island.app running, so the
// status starts at `dev-disabled` and only flips to `idle` on real boot
// + handshake.

import { existsSync } from 'fs'

import { buildPing } from './envelope'
import { resolveSocketPath, sendEnvelope, type SendOutcome } from './sender'

/** Default probe cadence: 60s during dev, 5min in production. The probe is
 *  cheap (1 syscall + at most 1 socket open) so even 60s burns < 1 CPU-ms /
 *  hour. Production extends the cadence so a sleeping ping-island doesn't
 *  rack up false-negative noise in the Settings page. */
const PROBE_INTERVAL_MS_DEV = 60_000
const PROBE_INTERVAL_MS_PROD = 300_000

export type IslandConnectionState =
  /** No probe attempt yet (first 100ms after registerIslandHandlers). */
  | 'idle'
  /** Socket file present + last Ping completed OK. */
  | 'connected'
  /** Socket file present but Ping failed (timeout / protocol / refused). */
  | 'degraded'
  /** Socket file missing — ping-island.app not running. */
  | 'disconnected'
  /** Dev mode (`is.dev`) — we don't auto-probe; renderer can still trigger
   *  a manual test via the Settings page. */
  | 'dev-disabled'
  /** User toggled the integration off via Settings. */
  | 'disabled'

export interface IslandStatus {
  state: IslandConnectionState
  socketPath: string
  /** Last probe outcome — useful for the Settings "test connection" CTA. */
  lastProbeAt: number | null
  /** Last error message surfaced to the user. */
  lastError: string | null
}

export type IslandStatusListener = (status: IslandStatus) => void

let _status: IslandStatus = {
  state: 'idle',
  socketPath: resolveSocketPath(),
  lastProbeAt: null,
  lastError: null
}

const listeners: Set<IslandStatusListener> = new Set()
let probeTimer: ReturnType<typeof setInterval> | null = null
let _intervalMs: number = PROBE_INTERVAL_MS_PROD

export function getIslandStatus(): IslandStatus {
  return _status
}

export function subscribeIslandStatus(listener: IslandStatusListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setStatus(patch: Partial<IslandStatus>): void {
  _status = { ..._status, ...patch }
  for (const listener of listeners) {
    try {
      listener(_status)
    } catch {
      // listeners shouldn't throw, but never let one bad subscriber take
      // out the others.
    }
  }
}

/** Map a low-level `SendOutcome` to a coarse connection state for the UI. */
function outcomeToState(outcome: SendOutcome): {
  state: IslandConnectionState
  error: string | null
} {
  if (outcome.ok) return { state: 'connected', error: null }
  switch (outcome.reason) {
    case 'enoent':
      return { state: 'disconnected', error: null }
    case 'refused':
      return { state: 'disconnected', error: outcome.detail }
    case 'timeout':
    case 'protocol':
    case 'unknown':
      return { state: 'degraded', error: outcome.detail }
  }
}

/**
 * Run one probe tick. Exported separately so the Settings page can trigger
 * an immediate retest without waiting for the scheduled interval.
 */
export async function probeOnce(): Promise<IslandStatus> {
  // Honour the disabled / dev-disabled latch — Settings sets these states
  // out-of-band and we shouldn't override them on the next interval tick.
  if (_status.state === 'disabled' || _status.state === 'dev-disabled') {
    return _status
  }
  const socketPath = _status.socketPath
  if (!existsSync(socketPath)) {
    setStatus({ state: 'disconnected', lastProbeAt: Date.now(), lastError: null })
    return _status
  }
  const outcome = await sendEnvelope(buildPing(), { socketPath })
  const mapped = outcomeToState(outcome)
  setStatus({ state: mapped.state, lastProbeAt: Date.now(), lastError: mapped.error })
  return _status
}

export interface StartProbeOpts {
  /** When `is.dev=true` the handler passes `devDisabled:true` to skip the
   *  auto-loop. The Settings page can still invoke `probeOnce()`. */
  devDisabled?: boolean
  intervalMs?: number
}

export function startProbeLoop(opts?: StartProbeOpts): void {
  if (probeTimer !== null) return
  if (opts?.devDisabled) {
    setStatus({ state: 'dev-disabled', lastProbeAt: null, lastError: null })
    return
  }
  _intervalMs = opts?.intervalMs ?? PROBE_INTERVAL_MS_PROD
  // Run one probe near startup so the renderer's first status fetch returns
  // a useful state (idle → connected/disconnected) instead of the seed.
  setTimeout(() => {
    void probeOnce()
  }, 100)
  probeTimer = setInterval(() => {
    void probeOnce()
  }, _intervalMs)
}

export function stopProbeLoop(): void {
  if (probeTimer !== null) {
    clearInterval(probeTimer)
    probeTimer = null
  }
}

/** Toggle the integration on/off from Settings. `enabled=false` parks the
 *  status at 'disabled' and skips probes until re-enabled. */
export function setIslandEnabled(enabled: boolean): IslandStatus {
  if (!enabled) {
    stopProbeLoop()
    setStatus({ state: 'disabled', lastProbeAt: null, lastError: null })
    return _status
  }
  setStatus({ state: 'idle', lastProbeAt: null, lastError: null })
  startProbeLoop({ intervalMs: _intervalMs })
  return _status
}

/** Hard reset for tests. */
export function __resetForTesting(socketPath?: string): void {
  stopProbeLoop()
  listeners.clear()
  _status = {
    state: 'idle',
    socketPath: socketPath ?? resolveSocketPath(),
    lastProbeAt: null,
    lastError: null
  }
}

export const __testing = {
  setStatus,
  outcomeToState,
  PROBE_INTERVAL_MS_DEV,
  PROBE_INTERVAL_MS_PROD
}
