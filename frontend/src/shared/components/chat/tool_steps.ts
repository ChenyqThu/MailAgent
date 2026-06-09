// task 06-08-chat PR B — pure normalizers + classification for the Cowork tool
// group. Replaces the per-offset interleaving (Bug 2) with a grouped,
// time-ordered step list per handoff §2 + §6.
//
// Split out of MessageList.tsx so the logic is unit-testable in a plain node env
// (no lucide / Streamdown / IPC pulled in) — mirroring the convention the old
// tool_interleave.ts established. The renderer (ToolStep / ToolGroup) maps the
// returned ToolStepData[] to elements 1:1; asserting the normalization here ==
// asserting what the group renders.
//
// Two sources feed a single ToolStepData: the live `LiveToolCall` map (built
// from the harness stream during streaming) and the persisted `ChatToolCall`
// audit rows (fetched after `done`). The two phases must dovetail without a gap
// (see AssistantBubble for the live→audit fallback).

import type { ChatToolCall } from '@shared/api/types'
import type { LiveToolCall } from '@shared/hooks/useEmailChat'

/** Tool kind classification for the Cowork timeline. Maps a tool_name to one of
 *  six visual buckets (icon + accent token), per handoff §2.4. */
export type ToolKind = 'search' | 'read' | 'task' | 'write' | 'cmd' | 'link'

/** A status that covers both the live (running/ok/error/canceled) and the
 *  persisted (pending/confirmed/running/ok/error/canceled) state machines. */
export type ToolStepStatus = 'pending' | 'confirmed' | 'running' | 'ok' | 'error' | 'canceled'

/** Unified step model the ToolStep renderer consumes. Built from either a live
 *  tool call or a persisted audit row (see liveSteps / auditSteps). */
export interface ToolStepData {
  /** Stable React key — toolUseId (live) or String(id) (audit). */
  key: string
  toolName: string
  /** Pretty-printed JSON of the effective input. */
  inputJson: string
  /** Pretty-printed JSON of the output, or null while still running / no output. */
  outputJson: string | null
  status: ToolStepStatus
  durationMs: number | null
  /** True when the persisted row carried a user-edited input. */
  userEdited: boolean
}

/** Name-based heuristic. Order matters: write/link/cmd specific prefixes are
 *  checked before the generic read/task/search fallbacks. */
export function classifyTool(name: string): ToolKind {
  const n = name.toLowerCase()
  // write — mutating mailbox state (flag / archive / move / mark).
  if (
    n.startsWith('email_flag') ||
    n.startsWith('email_archive') ||
    n.includes('_flag') ||
    n.includes('archive') ||
    n.includes('_move') ||
    n.includes('mark_')
  )
    return 'write'
  // link — KOS / Notion association.
  if (n.startsWith('kos_') || n.includes('kos') || n.includes('notion') || n.includes('link'))
    return 'link'
  // cmd — shell / command execution.
  if (n.includes('bash') || n.includes('command') || n.includes('exec') || n.includes('shell'))
    return 'cmd'
  // read — fetch an email body / read-class.
  if (n.includes('body') || n.startsWith('email_get') || n.includes('read') || n.includes('fetch'))
    return 'read'
  // task — extraction / action-item style.
  if (n.startsWith('extract_') || n.includes('extract') || n.includes('task')) return 'task'
  // search — find / search fallthrough.
  if (n.includes('search') || n.includes('find')) return 'search'
  // Default to search (neutral magnifier) for anything unrecognized.
  return 'search'
}

/** Pretty-print arbitrary JSON-ish input. Accepts a value (live event input) or
 *  a JSON string (audit row); returns a 2-space-indented string. Falls back to
 *  the raw string / String(value) when parsing/serialization fails (tool output
 *  can be anything). */
export function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    // Audit rows store JSON text; re-pretty-print, else show verbatim.
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Normalize the live tool-call map entries into ToolStepData. */
export function liveSteps(calls: ReadonlyArray<LiveToolCall> | undefined): ToolStepData[] {
  if (!calls || calls.length === 0) return []
  return calls.map((c) => ({
    key: c.toolUseId,
    toolName: c.name,
    inputJson: prettyJson(c.input),
    outputJson:
      c.status === 'error'
        ? c.errorMessage
          ? prettyJson(c.errorMessage)
          : null
        : c.output !== undefined
          ? prettyJson(c.output)
          : null,
    status: c.status,
    durationMs: c.durationMs,
    userEdited: false
  }))
}

/** Normalize persisted audit rows into ToolStepData. */
export function auditSteps(calls: ReadonlyArray<ChatToolCall>): ToolStepData[] {
  return calls.map((c) => ({
    key: String(c.id),
    toolName: c.tool_name,
    inputJson: c.user_edited_input_json ?? c.input_json,
    outputJson: c.output_json,
    status: c.status,
    durationMs: c.duration_ms,
    userEdited: c.user_edited_input_json !== null
  }))
}
