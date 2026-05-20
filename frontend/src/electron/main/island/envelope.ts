// Sprint 9 §2.1 — Island BridgeEnvelope builders.
//
// ISLAND-PLUGIN.md §3.2 defines the JSON shape MailAgent emits over the
// `/tmp/island.sock` unix socket. ping-island's fork (feat/mail-brand) decodes
// it through `BridgeProvider.mail` → `SessionProvider.mail` so we stay on the
// `.mail` brand registered in `ClientProfile.swift:547`.
//
// Two design rules baked into this module:
//   1. **Swift Date epoch**: `sentAt` is seconds since 2001-01-01 UTC (Apple
//      reference date), NOT since 1970. The conversion `unixSeconds - 978307200`
//      keeps the value compatible with `JSONDecoder().dateDecodingStrategy
//      = .deferredToDate` which is what HookSocketServer.swift uses.
//   2. **Provider-agnostic generic fields**: `title` + `preview` + `metadata`
//      are the only things ping-island's generic `HoverSessionCard` consumes
//      for non-attentionNotification routes. Per ISLAND-PLUGIN §2.5.1, mail
//      events fall through `.attentionNotification` / `.hoverDashboard` /
//      `.sessionList`, all of which render via that card — so we always set
//      these three.
//
// The Electron side only emits *outbound* envelopes that the renderer
// generates (theme/accent change + AI draft 3-phase). Mail-flow events
// (MailReceived / LLMReviewed / MailCompleted / SyncFailed / DeadLetterAccum)
// are the Python plugin's job (ISLAND-PLUGIN.md §4.3) and live in
// `src/notify/island_dispatch.py`.

import { randomUUID } from 'crypto'

/** Swift `Date(timeIntervalSinceReferenceDate:)` offset. Seconds between
 *  2001-01-01T00:00:00Z and the Unix epoch. */
const SWIFT_REFERENCE_DATE_OFFSET = 978_307_200

/** Encode `Date.now()` ms → Swift seconds-since-2001 double. */
export function swiftSentAt(now: number = Date.now()): number {
  return now / 1000 - SWIFT_REFERENCE_DATE_OFFSET
}

/** ping-island wire-layer enum members the fork accepts after Sprint 1's
 *  `.mail` patches (ISLAND-PLUGIN.md §2.1 / §2.1b / §2.1c). */
export type IslandProvider = 'mail'

/** Event names the Electron side emits. The Python plugin owns the
 *  mail-flow events; we own appearance + AI draft.
 *
 *  Sprint 10 (b) §2.5.4-D 方案 A: this is the SEMANTIC event name we keep
 *  in builder API + island_dispatch SQLite + tests. On the wire we map all
 *  of these to ping-island's known `"Notification"` hook (the fork's
 *  dispatcher only recognises `UserPromptSubmit` / `PreToolUse` /
 *  `Notification` / `Stop` / `SessionStart`), and stash the real semantic
 *  name in `metadata['mailagent.eventType']` for the fork to consume / for
 *  future Plan B (Swift fork adds mail-specific case). */
export type IslandEventType =
  | 'AppearanceChange'
  | 'AIDraftStart'
  | 'AIDraftStream'
  | 'AIDraftReady'
  | 'Ping'

/** Wire-layer event name. Always `"Notification"` after Sprint 10 (b) — see
 *  `_WIRE_EVENT_MAP` below + ISLAND-PLUGIN.md §2.5.4-D. */
export type IslandWireEventType = 'Notification'

/** Sprint 10 (b) §2.5.4-D Plan A — semantic → wire event mapping. Always
 *  collapses to `"Notification"` so ping-island's existing hook dispatcher
 *  accepts the envelope; consumers read `metadata.mailagent.eventType` to
 *  recover the original intent. */
const _WIRE_EVENT_MAP: Record<IslandEventType, IslandWireEventType> = {
  AppearanceChange: 'Notification',
  AIDraftStart: 'Notification',
  AIDraftStream: 'Notification',
  AIDraftReady: 'Notification',
  Ping: 'Notification'
}

/** ping-island `Status.kind`. Mirrors the Swift `SessionState.Phase` mapping
 *  in HookPayloadMapper. */
export type IslandStatusKind = 'notification' | 'waitingForInput' | 'completed' | 'error'

export interface BridgeEnvelope {
  id: string
  provider: IslandProvider
  /** Sprint 10 (b) §2.5.4-D Plan A — `"Notification"` on the wire so
   *  ping-island's dispatcher accepts the frame. The original semantic
   *  event lives in `metadata['mailagent.eventType']`. */
  eventType: IslandWireEventType
  sessionKey: string
  title: string
  preview: string
  cwd: null
  status: { kind: IslandStatusKind; detail: string | null }
  terminalContext: Record<string, never>
  intervention: null
  expectsResponse: boolean
  metadata: Record<string, string>
  sentAt: number
}

export interface AppearanceChangePayload {
  accent: string
  theme: 'dark' | 'light'
  lang?: string
}

export interface AIDraftStartPayload {
  emailId: number
  senderName: string | null
  subject: string | null
  /** Plain-text message the user just sent in the AI Chat composer.
   *  Truncated to 240 chars so the envelope stays well under 64 KiB. */
  prompt: string
}

export interface AIDraftStreamPayload {
  emailId: number
  /** Running count of characters streamed so far — used by ping-island
   *  Phase 1 pill to render `…2.4k chars` instead of a fake progress bar. */
  streamedChars: number
}

export interface AIDraftReadyPayload {
  emailId: number
  senderName: string | null
  subject: string | null
  /** First ~240 chars of the final draft so the user can decide whether to
   *  switch to MailAgent.app or dismiss without leaving the island. */
  preview: string
}

/** AI Chat sessions key into one `mailagent:chat:<id>` session per email so
 *  three events from the same composer flow collapse into one ping-island
 *  session row (subsequent events just update the existing row). */
function chatSessionKey(emailId: number): string {
  return `mailagent:chat:${emailId}`
}

const PREVIEW_MAX = 240

function clipPreview(value: string | null | undefined): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (trimmed.length <= PREVIEW_MAX) return trimmed
  return trimmed.slice(0, PREVIEW_MAX - 1) + '…'
}

function commonShell(
  eventType: IslandEventType,
  sessionKey: string,
  title: string,
  preview: string,
  metadata: Record<string, string>,
  opts?: { expectsResponse?: boolean; statusKind?: IslandStatusKind; now?: number }
): BridgeEnvelope {
  return {
    id: randomUUID(),
    provider: 'mail',
    // Sprint 10 (b) §2.5.4-D Plan A — wire event collapses to "Notification",
    // semantic event preserved in metadata.mailagent.eventType so consumers
    // (ping-island fork / future Plan B Swift case / Settings debug) can
    // still distinguish AppearanceChange from AIDraftStream from Ping.
    eventType: _WIRE_EVENT_MAP[eventType],
    sessionKey,
    title,
    preview,
    cwd: null,
    status: { kind: opts?.statusKind ?? 'notification', detail: null },
    terminalContext: {},
    intervention: null,
    expectsResponse: opts?.expectsResponse ?? false,
    metadata: { ...metadata, 'mailagent.eventType': eventType },
    sentAt: swiftSentAt(opts?.now)
  }
}

export function buildAppearanceChange(
  payload: AppearanceChangePayload,
  opts?: { now?: number }
): BridgeEnvelope {
  return commonShell(
    'AppearanceChange',
    'mailagent:system:appearance',
    // Generic UI cards won't render this one (status.kind=notification on a
    // system event with empty preview), but ping-island's fork can react to
    // metadata.* to repaint the accent. Keep title/preview non-empty so the
    // card doesn't visually break if a future fork DOES render it.
    'MailAgent appearance updated',
    '',
    {
      'mailagent.accent': payload.accent,
      'mailagent.theme': payload.theme,
      ...(payload.lang ? { 'mailagent.lang': payload.lang } : {})
    },
    opts
  )
}

export function buildAIDraftStart(
  payload: AIDraftStartPayload,
  opts?: { now?: number }
): BridgeEnvelope {
  const senderLabel = payload.senderName ?? '—'
  return commonShell(
    'AIDraftStart',
    chatSessionKey(payload.emailId),
    `AI 起草中 / ${senderLabel}`,
    clipPreview(payload.subject),
    {
      'mailagent.internalId': String(payload.emailId),
      'mailagent.senderName': payload.senderName ?? '',
      'mailagent.subject': payload.subject ?? '',
      'mailagent.draftPhase': 'start',
      'mailagent.prompt': clipPreview(payload.prompt)
    },
    opts
  )
}

export function buildAIDraftStream(
  payload: AIDraftStreamPayload,
  opts?: { now?: number }
): BridgeEnvelope {
  return commonShell(
    'AIDraftStream',
    chatSessionKey(payload.emailId),
    'AI 起草中',
    '',
    {
      'mailagent.internalId': String(payload.emailId),
      'mailagent.draftPhase': 'stream',
      'mailagent.streamedChars': String(payload.streamedChars)
    },
    opts
  )
}

export function buildAIDraftReady(
  payload: AIDraftReadyPayload,
  opts?: { now?: number }
): BridgeEnvelope {
  const senderLabel = payload.senderName ?? '—'
  return commonShell(
    'AIDraftReady',
    chatSessionKey(payload.emailId),
    `AI 草稿就绪 / ${senderLabel}`,
    clipPreview(payload.preview),
    {
      'mailagent.internalId': String(payload.emailId),
      'mailagent.senderName': payload.senderName ?? '',
      'mailagent.subject': payload.subject ?? '',
      'mailagent.draftPhase': 'ready'
    },
    { ...opts, statusKind: 'completed' }
  )
}

/** Liveness probe — minimal envelope to confirm ping-island accepts a
 *  `.mail` provider frame. Sent by `probe.ts` on startup + every probe
 *  interval to update the connection status. */
export function buildPing(opts?: { now?: number }): BridgeEnvelope {
  return commonShell(
    'Ping',
    'mailagent:system:ping',
    'MailAgent ping',
    '',
    { 'mailagent.kind': 'liveness' },
    opts
  )
}

/** Exposed for tests + reconnect logic that needs the byte length without
 *  re-encoding. */
export function serializeEnvelope(env: BridgeEnvelope): Buffer {
  return Buffer.from(JSON.stringify(env), 'utf8')
}
