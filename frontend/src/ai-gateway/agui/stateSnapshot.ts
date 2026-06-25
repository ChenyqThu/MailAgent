// chat-panel P4 Phase 05 — AG-UI STATE_SNAPSHOT builder + redaction.
//
// The mirror emits one AG-UI `STATE_SNAPSHOT` near the start of a run so an external AG-UI client
// can render the agent's standing state (which thread, what it can do) without re-deriving it from
// the message stream. This module builds that snapshot (phase-05 §6 MailAgentAgUiState) and — most
// importantly — REDACTS it: the snapshot is a small, safe projection, NOT a dumping ground.
//
// 🔴 Two hard redaction rules (phase-05 §6):
//    1. secrets never enter the state — any provider key / token / authorization / cookie field is
//       dropped (defence-in-depth: the gateway never puts a key here, but a future caller might pass
//       a context blob that carries one, so we strip by key-name unconditionally).
//    2. large bodies are truncated — the full email body is NOT repeated into the snapshot; long
//       strings are clipped to MAX_SNAPSHOT_STRING with a marker so the snapshot stays small.
//
// 🔴 Pure TS (no node:* / electron / ai) — harness-testable; safe in the gateway core + tests.

import { AgUiEventType, type AgUiStateSnapshotEvent } from './events'

/** A lightweight standing-context blob the caller may attach (the real layered standing-context
 *  snapshot lands in a later phase; until then this is an open passthrough that we redact). */
export type AgentContextSnapshot = Record<string, unknown>

/** The AG-UI state object the mirror snapshots (phase-05 §6). `highRiskApprovalRequired` is a
 *  literal `true` — the mirror can never silently auto-send; it always routes through approval. */
export interface MailAgentAgUiState {
  mailagentContext: AgentContextSnapshot
  thread: {
    sessionId: number | null
    anchorType: 'email' | 'general'
    anchorId: number | null
  }
  capabilities: {
    enabledTools: string[]
    enabledSkills: string[]
    highRiskApprovalRequired: true
  }
}

/** Inputs to build the snapshot (the route assembles these from the request + gateway config). */
export interface BuildStateSnapshotInput {
  context?: AgentContextSnapshot | null
  sessionId?: number | null
  anchorType?: 'email' | 'general' | null
  anchorId?: number | null
  enabledTools?: readonly string[]
  enabledSkills?: readonly string[]
}

/** Max length of any single string kept in the snapshot. Longer strings are clipped — the snapshot
 *  is a state projection, not a body store (the body streams as text/tool parts, not state). */
export const MAX_SNAPSHOT_STRING = 2000

/** Key-name fragments whose values are ALWAYS dropped from the snapshot (case-insensitive). A
 *  defence-in-depth strip so no secret can ride into AG-UI state even if a caller stuffs one into
 *  the context blob. */
const SECRET_KEY_FRAGMENTS: readonly string[] = [
  'token',
  'apikey',
  'api_key',
  'secret',
  'password',
  'passwd',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'credential',
  'private_key',
  'privatekey',
  'session_key',
  'access_key'
]

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase()
  return SECRET_KEY_FRAGMENTS.some((frag) => k.includes(frag))
}

/** Recursively redact a value for the snapshot: drop secret-named keys, clip long strings, cap
 *  recursion depth (a malformed/cyclic blob can't blow the snapshot up). Arrays keep order. */
export function redactForState(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated:depth]'
  if (typeof value === 'string') {
    return value.length > MAX_SNAPSHOT_STRING
      ? `${value.slice(0, MAX_SNAPSHOT_STRING)}…[truncated:${value.length}]`
      : value
  }
  if (Array.isArray(value)) return value.map((v) => redactForState(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) continue // drop secrets entirely — not even a redacted placeholder
      out[k] = redactForState(v, depth + 1)
    }
    return out
  }
  // number / boolean / null / undefined → as-is.
  return value
}

/** Build the redacted MailAgent AG-UI state. The context blob is redacted; the thread + capability
 *  facets are taken from the request/config. `highRiskApprovalRequired` is hard-coded `true`. */
export function buildMailAgentAgUiState(input: BuildStateSnapshotInput): MailAgentAgUiState {
  const context = (input.context ?? {}) as AgentContextSnapshot
  return {
    mailagentContext: redactForState(context) as AgentContextSnapshot,
    thread: {
      sessionId: input.sessionId ?? null,
      anchorType: input.anchorType ?? 'general',
      anchorId: input.anchorId ?? null
    },
    capabilities: {
      enabledTools: [...(input.enabledTools ?? [])],
      enabledSkills: [...(input.enabledSkills ?? [])],
      highRiskApprovalRequired: true
    }
  }
}

/** Wrap a state object into an AG-UI STATE_SNAPSHOT event. */
export function stateSnapshotEvent(
  state: MailAgentAgUiState
): AgUiStateSnapshotEvent<MailAgentAgUiState> {
  return { type: AgUiEventType.StateSnapshot, snapshot: state }
}
