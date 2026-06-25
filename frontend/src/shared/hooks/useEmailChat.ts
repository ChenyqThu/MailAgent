// Sprint 4 §2.1 — per-email AI chat hook.
//
// The React side of the chat panel. Stays out of `vercel/ai` territory
// because (1) the transport is Electron IPC, not HTTP fetch, (2) the
// surface stays small enough that hand-rolling is shorter than wiring
// a custom transport into someone else's framework, (3) DESIGN.md §6
// + DESIGN.md §9.5 (⌘↩) are specific to MailAgent and the hook needs
// to coordinate with `useShortcut` directly.
//
// State machine:
//   emailId = null         → messages=[]; nothing in flight
//   emailId = N, no session → messages=[]; activeSessionId=null
//   emailId = N, sessions[0]
//                          → messages = listMessages(sessions[0].id)
//                            activeSessionId = sessions[0].id
//                            streamingMessageId set iff last assistant
//                            is still in 'streaming' or 'pending' state
//
//   send(...)              → chat.start → optimistic refresh +
//                            streamingMessageId set + stream events
//                            patch messages in place
//   stream chunk           → buffer-append the assistant message content
//   stream done            → mark complete + full refresh (SSoT) +
//                            clear streamingMessageId
//   stream error           → mark error + populate `error` slot +
//                            clear streamingMessageId
//   stream tool_call       → schedule refresh to pick up the new role=tool row
//
//   switch emailId         → useEffect cleanup fires chat.abort(prevSession)
//   unmount                → same path; stream stays correctly cancelled

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useMailApi } from './useMailApi'
import { applySkillMentions, useSkillActivation } from '../state/skill-activation'
import type { ChatBackendKind, ChatMessage, ChatSession, ChatStartResult } from '../api/types'

export interface SendChatInput {
  message: string
  backendKind: ChatBackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
  /** Sprint 10 reviewer L3 — populates the AIDraftStart/Ready envelope so
   *  ping-island can render `AI 起草中 / <senderName>` instead of `... / —`.
   *  Caller (AIChatPanel) reads these from the active email's detail query
   *  before calling `send()`. */
  senderName?: string | null
  subject?: string | null
  /** task 06-08-chat 需求 5 — per-turn extended-thinking toggle. AIChatPanel
   *  reads its persisted Composer toggle and passes the value at send time. */
  thinking?: boolean
}

// Sprint 14 PR B — inline message edit. The caller (MessageList) supplies
// the user-message id being edited + the new content + the backend
// choice. Hook truncates the dispatcher state (abort current stream +
// drop tail messages) and re-streams the assistant reply.
export interface EditChatInput {
  /** ai_chat_messages.id of the user message being edited. Backend
   *  rejects with E_INVALID_ARG if this id points at a non-user role. */
  messageId: number
  /** Replacement content. Backend rejects empty strings. */
  newContent: string
  backendKind: ChatBackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
  /** task 06-08-chat 需求 5 — per-turn extended-thinking toggle for the re-stream. */
  thinking?: boolean
}

export interface ChatError {
  code: string
  message: string
}

/** task 06-08-chat PR B — one live tool-call row, built from the harness's
 *  streaming `tool_use` / `tool_result` events. Mirrors the persisted
 *  `ChatToolCall` audit shape closely enough that MessageList can normalize
 *  both into a single `ToolStepData`. Lives only in renderer memory for the
 *  duration of a streaming turn; once `done` fires the renderer switches to the
 *  DB audit rows (`useToolCalls`). */
export interface LiveToolCall {
  toolUseId: string
  name: string
  input: unknown
  status: 'running' | 'ok' | 'error' | 'canceled'
  output?: unknown
  errorMessage?: string
  durationMs: number | null
}

/** Sprint 19 PR-1d.2 — one pending ConfirmToolDialog. The harness in
 *  the main process is blocked on a per-toolUseId promise waiting for the
 *  renderer to call confirmTool(); each entry here is one such block.
 *  Cleared when confirmTool() resolves ok or when the session aborts. */
export interface PendingConfirmation {
  sessionId: number
  messageId: number
  toolUseId: string
  toolName: string
  input: unknown
  /** Optional 1-line human summary the dialog renders above the JSON. */
  preview?: string
  /** preview = read-only OK/Cancel; edit = the user MAY edit `input` before
   *  approving (used for email_draft_reply). */
  tier: 'preview' | 'edit'
  /** task 06-08-chat PR D (§4.3) — once the user decides, the IPC fires
   *  IMMEDIATELY (闭环不变) but the card lingers ~1.3s showing a "decided"
   *  banner before being filtered out. This flag drives that banner; absent
   *  while the card is still awaiting a decision. */
  resolved?: 'confirmed' | 'rejected'
}

export interface UseEmailChatReturn {
  /** Messages of the active session, oldest-first. Empty when no session yet. */
  messages: ChatMessage[]
  /** Phase 06-parity — the session id `messages` reflects (set after a load lands, even for a 0-row
   *  session; null when none loaded / reset). The AI SDK reload gate uses it to tell a loaded-empty
   *  session from a still-loading stale array. */
  messagesSessionId: number | null
  /** The id of the assistant message currently being streamed, or null. */
  streamingMessageId: number | null
  /** Convenience: streamingMessageId !== null. */
  isStreaming: boolean
  /** Last surfaceable error from a backend stream or a dispatch failure. */
  error: ChatError | null
  /** Currently-displayed session id (latest by default). */
  activeSessionId: number | null
  /** Append a user message + kick the backend stream. */
  send: (input: SendChatInput) => Promise<ChatStartResult>
  /** Cancel the in-flight stream on the active session. */
  abortCurrent: () => void
  /** Dismiss the error banner. */
  clearError: () => void
  /** Sprint 13 — "+ New conversation" affordance. Aborts the active
   *  stream, clears renderer-side messages/error, and unsets
   *  activeSessionId so the next `send()` opens a fresh session for the
   *  current email. Backend keeps the older session row intact; a Sprint
   *  14 history sidebar will surface a switcher. */
  newSession: () => void
  /** Sprint 5 §2.3 state-machine #3 — re-fire the last failed input, if any.
   *  Surfaces a `Retry` button next to network / upstream errors. Null when
   *  there's nothing retryable (initial render, after success, etc.). */
  retryLast: (() => Promise<void>) | null
  /** Sprint 5 §2.3 state-machine #4 — epoch millis when the upstream quota
   *  cooldown lifts, or null when not throttled. AIChatPanel disables
   *  `send` until this passes; Composer footer surfaces the remaining
   *  seconds via `useTimeUntil`. */
  quotaCooldownUntil: number | null
  /** task 06-15 Bug 2 — the backend kind that owns the active cooldown (the
   *  tab where the E_QUOTA cap was hit). AIChatPanel only treats the cooldown
   *  as engaged when this matches the currently-selected backend, so a quota
   *  cap on Custom AI never throttles the Notion Agent tab (and vice versa).
   *  Null whenever `quotaCooldownUntil` is null. */
  quotaCooldownKind: ChatBackendKind | null
  /** Sprint 14 PR A — all sessions for the current email, ordered by
   *  updated_at DESC. Surfaced to the history sidebar; refreshed on email
   *  switch + after each successful `send()` (which may have created a
   *  fresh session row). */
  sessions: ChatSession[]
  /** Sprint 14 PR A — switch the renderer to a different session for the
   *  current email. Aborts any in-flight stream, loads the target session's
   *  messages, and points `activeSessionId` at the new session. */
  selectSession: (sessionId: number) => Promise<void>
  /** Phase 06a (cutover) — fold a session the AI SDK path created out-of-band
   *  (renderer IPC, backend_kind='ai-sdk') into the hook state: prepend it to
   *  `sessions`, point `activeSessionId` + `messagesSessionId` at it, and reset
   *  messages to empty (the AI SDK runtime owns the live turns; the row persists
   *  via the gateway's dual-write once the first turn finishes). No IPC / refresh. */
  adoptSession: (session: ChatSession) => void
  /** Sprint 14 PR B — edit a user message and re-stream the assistant
   *  reply. Backend truncates messages from `messageId` onward, appends
   *  a fresh user row with the new content, then runs the same dispatcher
   *  loop send() uses. Resolves with the new ids; rejects with
   *  `Error & { code }` on dispatch failure (the error also lands in
   *  `error` for banner display). */
  editMessage: (input: EditChatInput) => Promise<ChatStartResult>
  /** Sprint 14 PR J — delete a session. Aborts any in-flight stream on
   *  the target session, removes the row from the sessions list, and
   *  if it was the active session resets to "no session" (matching
   *  newSession()'s renderer state shape). */
  deleteSession: (sessionId: number) => void
  /** Sprint 19 PR-1d.2 — list of tools the agent harness is currently
   *  blocked on, awaiting user confirmation. Empty unless the harness
   *  surfaced a preview/edit-tier tool. Renderer renders one
   *  ConfirmToolDialog per entry. */
  pendingConfirmations: PendingConfirmation[]
  /** Sprint 19 PR-1d.2 — reply to a ConfirmToolDialog. Returns the IPC
   *  envelope so the caller can show a toast on `E_NOT_PENDING` (late
   *  click after session abort). On `ok:true` the entry is removed from
   *  `pendingConfirmations` synchronously. */
  confirmTool: (
    toolUseId: string,
    approved: boolean,
    editedInput?: unknown
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>
  /** task 06-08-chat PR B — live (streaming) tool-call rows keyed by the
   *  assistant message id. Built from the harness's `tool_use` / `tool_result`
   *  events so the Cowork tool group updates step-by-step during the turn,
   *  without waiting for the post-`done` audit fetch. Empty for any message not
   *  currently streaming tools; the renderer reads the DB audit rows once the
   *  turn settles. */
  liveToolCalls: Map<number, LiveToolCall[]>
  /** R3 — the per-scope @mention activation key for this (email, kind). The panel passes
   *  it to Composer so ActiveSkillChips renders only THIS scope's activated skills, never
   *  another email's or the General Agent's. */
  skillScopeKey: string
}

// Sprint 5 §2.3 state-machine #4: quota cooldown duration. The Anthropic
// `E_QUOTA` reflects either a per-minute or per-day cap upstream; 5 minutes
// is the conservative midpoint that lets the user keep working without
// hammering CRS while we wait. Sprint 6 SettingsPage may expose an override.
const QUOTA_COOLDOWN_MS = 5 * 60 * 1000

// Sprint 6 Day 1 (opus LOW carry-forward) — persist cooldown across reloads
// so an app restart inside the 5-min window doesn't unmute the user back
// into another upstream 429. Cosmetic fix; the in-memory path was already
// correct for the common case.
const QUOTA_COOLDOWN_STORAGE_KEY = 'mailagent.chat.quotaCooldownUntil'
// task 06-15 Bug 2 — the cooldown is now scoped to the backend kind that
// triggered it (only custom-api emits E_QUOTA), so the Notion Agent tab and
// the Custom AI tab no longer share one throttle. We persist that owning kind
// alongside the timestamp in a SECOND key (rather than reformatting the
// timestamp key) so the legacy bare-int value stays readable across upgrades.
const QUOTA_COOLDOWN_KIND_KEY = 'mailagent.chat.quotaCooldownKind'

function readPersistedQuotaCooldown(): number | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(QUOTA_COOLDOWN_STORAGE_KEY)
    if (v === null) return null
    const ts = parseInt(v, 10)
    if (!Number.isFinite(ts)) {
      localStorage.removeItem(QUOTA_COOLDOWN_STORAGE_KEY)
      return null
    }
    // Lazy GC: stale entries clean themselves up on next read.
    if (ts <= Date.now()) {
      localStorage.removeItem(QUOTA_COOLDOWN_STORAGE_KEY)
      return null
    }
    return ts
  } catch {
    // localStorage unavailable (privacy mode, SSR, etc.) — in-memory fallback
    // still works for the current session.
    return null
  }
}

function readPersistedQuotaCooldownKind(): ChatBackendKind | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(QUOTA_COOLDOWN_KIND_KEY)
    // Only the two known kinds are valid owners; anything else (or a missing
    // key from a pre-Bug-2 cooldown) reads as null so the gate below stays safe.
    return v === 'notion-agent' || v === 'custom-api' ? v : null
  } catch {
    return null
  }
}

// 交付文档 §3.1 (用户清单 Bug 4) — per-scope key. The chat surface is scoped
// to BOTH the email AND the backend kind: Notion Agent and Custom AI are two
// independent assistants whose session history + active conversation must NOT
// bleed into each other. `${emailId}:${backendKind}` is that scope identity;
// it keys the all-sessions filter, the latest-session pick, and the
// per-scope activeSessionId memory below.
function scopeKey(emailId: number | null, backendKind: ChatBackendKind): string {
  return `${emailId ?? 'null'}:${backendKind}`
}

export function useEmailChat(
  emailId: number | null,
  backendKind: ChatBackendKind
): UseEmailChatReturn {
  const mailApi = useMailApi()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  // chat-panel P4 Phase 06-parity (codex review) — the session id `messages` currently reflects
  // (set by refresh AFTER a load completes, even for a 0-row session; null when no session is loaded
  // or it was reset). The AI SDK session-reload gate reads this to distinguish "session loaded, 0
  // history" from "load in flight, messages still stale" — `selectSession` flips activeSessionId
  // BEFORE refresh resolves, so an empty stale array would otherwise read as ready. Legacy path never
  // reads it (write-only there) → zero legacy regression.
  const [messagesSessionId, setMessagesSessionId] = useState<number | null>(null)
  const [activeSessionId, setActiveSessionIdState] = useState<number | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  // 交付文档 §3.1 — track the LAST committed scope (email + kind) so the
  // "Adjusting state on prop change" block can reset derived state synchronously
  // when EITHER the email OR the backend kind changes (kind switch is now a
  // first-class navigation event, same weight as an email switch).
  const [lastScope, setLastScope] = useState<string>(scopeKey(emailId, backendKind))
  // Tracks the last committed emailId separately from the scope so the adjust
  // block can tell an EMAIL change (invalidates `allSessions`) from a kind-only
  // change (reuses the cached list).
  const [lastEmailId, setLastEmailId] = useState<number | null>(emailId)
  // Sprint 14 PR A — sessions for the current email/kind scope; surfaced to the
  // history sidebar. The full email-scoped list is fetched once per email; the
  // kind filter is applied below before exposing `sessions`. Loaded by effect #1
  // on email switch, refreshed after each successful send (which may have
  // created a new row).
  //
  // 交付文档 §3.1 — `allSessions` holds the WHOLE email's sessions (every
  // backend kind); `sessions` (the public field) is the current-kind subset.
  // Keeping the raw list lets a kind switch re-filter without a redundant
  // listSessions IPC (only the kind changed; the DB rows didn't).
  const [allSessions, setAllSessions] = useState<ChatSession[]>([])
  /** Sprint 5 state machine #3 — captures the last input that failed so a
   *  Retry button can re-fire it. Set on every send(); cleared on success
   *  done event. */
  const [lastFailedInput, setLastFailedInput] = useState<SendChatInput | null>(null)
  /** Sprint 5 state machine #4 — epoch millis when the quota cap lifts.
   *  Set on E_QUOTA error, naturally elapses via the useEffect timer below.
   *  Sprint 6 Day 1: lazy initializer reads from localStorage so an app
   *  restart inside the 5-min cooldown still respects the throttle. */
  const [quotaCooldownUntil, setQuotaCooldownUntil] = useState<number | null>(() =>
    readPersistedQuotaCooldown()
  )
  // task 06-15 Bug 2 — owning backend kind for the cooldown above (see the
  // interface doc). Both reads hit localStorage once on mount; the timestamp
  // read GCs an expired entry, but the kind read is side-effect-free, so a
  // stale kind without a live timestamp simply never matches the gate.
  const [quotaCooldownKind, setQuotaCooldownKind] = useState<ChatBackendKind | null>(() =>
    readPersistedQuotaCooldownKind()
  )
  // Sprint 19 PR-1d.2 — pending ConfirmToolDialog queue. The harness can
  // surface multiple confirmations within a single iter (rare but possible
  // when the LLM emits N tool_use blocks of preview/edit tier in one turn),
  // so this stays an array — UI renders them in arrival order.
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingConfirmation[]>([])

  // task 06-08-chat PR B — live tool-call rows for the in-flight turn, keyed by
  // assistant message id. The harness forwards `tool_use` (running start) +
  // `tool_result` (terminal) events on the stream; we mirror them here so the
  // Cowork tool group renders steps as they happen instead of waiting for the
  // post-`done` audit fetch. Cleared on navigation switches (email change /
  // newSession / selectSession / deleteSession-of-active) so a stale turn's
  // steps never bleed into a fresh conversation.
  const [liveToolCalls, setLiveToolCalls] = useState<Map<number, LiveToolCall[]>>(new Map())

  // Mirror the latest committed emailId into a ref so `send()` can detect
  // a switch that happened while `chat.start()` was in flight. The closure
  // captures the emailId at call time; the ref reflects the latest render's
  // value. Comparing the two at resolve catches stale-send (codex High
  // carry-forward). Ref is written from an effect, never during render
  // (react-hooks/refs lint rule).
  const emailIdRef = useRef(emailId)
  useEffect(() => {
    emailIdRef.current = emailId
  }, [emailId])

  // 交付文档 §3.1 — mirror the backend kind into a ref so async callbacks
  // (send / refresh-derived helpers) can read the kind active at call time
  // without widening their dep arrays. Written from an effect, never during
  // render (react-hooks/refs).
  const backendKindRef = useRef(backendKind)
  useEffect(() => {
    backendKindRef.current = backendKind
  }, [backendKind])

  // 交付文档 §3.1 — per-(email, kind) activeSessionId memory. When the user
  // switches scope (email OR kind) we restore the session they last had open in
  // the TARGET scope rather than always falling back to "latest". key =
  // scopeKey(emailId, kind); value = the activeSessionId last seen in that scope
  // (or null for "no session yet"). A ref (not state): it's a side-table read at
  // navigation time, not rendered, and writing it must not trigger a re-render.
  const activeByScopeRef = useRef<Map<string, number | null>>(new Map())

  // Track whether the component is still mounted so a `chat.start()` that
  // resolves after unmount can abort the stranded session and skip the
  // setState calls (the same React warning that motivated the stale-send
  // guard would log a "setState on unmounted component" otherwise).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // task 06-08-chat Bug 1 (codex REQUEST CHANGES follow-up) — assistant
  // message ids whose stream has reached a terminal state locally (done /
  // error / abort). After the 3c cutover `finalizeMessage` is an async PATCH
  // that runs AFTER the harness forwards the terminal event, so a refresh
  // (GET) issued before the terminal event — but resolving after it — can
  // still read the row as `streaming` with null token/cost and stale content.
  // This generation guard lets `refresh` ignore such stale live rows for ids
  // we already finished:
  //   - the streamingMessageId re-derive skips terminal ids → a late
  //     refresh(true) (tool_call / idx=-1 recovery / send / abort) can't
  //     resurrect the spinner (the HIGH finding);
  //   - the setMessages merge keeps the local terminal row when the DB still
  //     reports it streaming → a racing GET can't roll the bubble back to
  //     streaming or drop the finalize-only token/cost fields (the MEDIUM
  //     finding).
  // Cleared at the top of the email switch / initial load effect and in
  // newSession so a fresh conversation — and crucially the reload-resume
  // path, which loads with this set empty — re-derives streaming rows from
  // the DB SSoT normally.
  const terminalIdsRef = useRef<Set<number>>(new Set())

  // task 06-08-chat Bug 1 (codex P0 NIT, promoted to a fix) — navigation
  // generation counter. The terminalIdsRef guard above is MESSAGE-level: it
  // protects a single assistant row against the done/finalize PATCH race.
  // Navigation switches (email change / newSession / selectSession /
  // deleteSession of the active session) are a SESSION-level race: each one
  // aborts the current session and resets renderer state, but a refresh(true)
  // already in flight for the OLD session (issued by send / chunk idx=-1
  // recovery / tool_call / done) will still resolve after the switch and call
  // setMessages(old rows) + setStreamingMessageId(old streaming) on top of the
  // freshly-loaded NEW session/email — pollution the message-level guard
  // can't catch (newSession even CLEARS terminalIdsRef, so it'd be empty).
  //
  // We bump this counter synchronously at every navigation switch point;
  // `refresh` captures it on entry and, after its `await listMessages`,
  // discards ALL of its setState if the counter moved (navigation happened
  // mid-flight). A generation counter is deliberately chosen over an
  // activeSessionRef/sessionId equality check: the initial-load path does
  // `setActiveSessionIdState(latest)` then immediately `await refresh(latest.id)`
  // while `activeSessionRef` is still the PRE-switch value (the effect that
  // syncs it hasn't run yet), so a sessionId guard would false-negative and
  // kill the legitimate refresh. The counter bumps synchronously at the
  // navigation site, so it has no such ordering dependency.
  // NOTE: abortCurrent does NOT bump — it terminates the current stream
  // (handled by terminalIdsRef) but stays on the same session, so its own
  // post-abort refresh must be allowed through.
  const navGenerationRef = useRef(0)

  // 交付文档 §3.1 — set by the navigation layout effect to the activeSessionId
  // the incoming scope was last on (or undefined when this scope was never
  // visited). The load effect (#1) consumes it to restore the remembered
  // conversation instead of always defaulting to the kind's latest session.
  // `undefined` = "no memory, fall back to latest"; a number = restore that id;
  // `null` = "scope was last on a blank new-session" (restore the empty state).
  const pendingScopeRestoreRef = useRef<number | null | undefined>(undefined)

  // task 06-08-chat Bug 1 (codex REQUEST CHANGES — HIGH) — email switch is the
  // one navigation vector whose bump can't ride the synchronous-event path the
  // other three (newSession / selectSession / deleteSession) use: it's driven
  // by a prop change. The bump MUST happen before the OLD email's in-flight
  // refresh(true) resolves, otherwise that refresh sees the un-bumped gen, the
  // guard passes it through, and it clobbers the freshly-loaded NEW email with
  // the old session's (streaming) rows.
  //
  // useLayoutEffect (not the passive load effect below, not a render-phase ref
  // mutation): it fires SYNCHRONOUSLY after commit — earlier than any passive
  // useEffect (so earlier than the async load's own refresh) AND, because JS is
  // single-threaded, earlier than the .then continuation of any refresh promise
  // that was already awaiting `listMessages` when emailId changed (that
  // continuation can only run once the current synchronous work unit — including
  // this layout effect — yields). So an old-email refresh that resolves right
  // after the switch necessarily reads the bumped gen and is discarded.
  //
  // A render-phase `navGenerationRef.current += 1` would trip
  // react-hooks/refs (no ref writes during render) and double-bump under
  // StrictMode's double-invoked render — hence the layout effect.
  //
  // terminalIdsRef is cleared here too (was in the passive load effect): the
  // incoming email starts with no terminal history, and clearing it in the
  // same synchronous commit step keeps the reload-resume path (which loads with
  // the set empty) deriving streaming rows from the DB SSoT normally.
  //
  // 交付文档 §3.1 — a backend-KIND switch is now a navigation event of the same
  // weight as an email switch (the two agents are independent threads), so this
  // layout effect bumps on EITHER emailId OR backendKind changing. Both are
  // prop-driven, so both ride the synchronous-commit useLayoutEffect path that
  // beats any old-scope refresh(true) still in flight (same argument as the
  // email-switch HIGH finding above).
  useLayoutEffect(() => {
    navGenerationRef.current += 1
    terminalIdsRef.current.clear()
    // 交付文档 §3.1 — snapshot the session this scope was last on BEFORE any
    // passive effect runs. The activeSessionRef sync effect (passive) writes
    // activeByScopeRef[newScope]=activeSessionId, and the "adjust on prop
    // change" block reset activeSessionId to null this render — so that passive
    // write would clobber the remembered value before the load effect could read
    // it. Reading it here (layout phase, before passive effects) captures the
    // pre-clobber value; the load effect consumes + clears it.
    pendingScopeRestoreRef.current = activeByScopeRef.current.get(scopeKey(emailId, backendKind))
  }, [emailId, backendKind])

  // React 19 "Adjusting state on prop change" (react.dev/learn/you-might-not-need-an-effect).
  // When the scope (emailId OR backendKind) switches, reset derived state
  // synchronously inside render rather than via an effect — keeps the renderer
  // from showing a frame of stale data, and avoids the
  // `react-hooks/set-state-in-effect` lint that would fire if we did the same
  // work in useEffect.
  //
  // 交付文档 §3.1 — keying on the full scope (email + kind) means a kind switch
  // resets the same derived state an email switch does, so the panel never shows
  // the OTHER agent's messages/streaming for a frame while effect #1 re-derives.
  const currentScope = scopeKey(emailId, backendKind)
  if (lastScope !== currentScope) {
    const emailChanged = lastEmailId !== emailId
    setLastScope(currentScope)
    setLastEmailId(emailId)
    setError(null)
    setMessages([])
    setMessagesSessionId(null)
    setActiveSessionIdState(null)
    setStreamingMessageId(null)
    setLastFailedInput(null)
    // Sprint 14 PR A / 交付文档 §3.1 — `allSessions` is the WHOLE email's list
    // (every kind). Only an EMAIL change invalidates it; a kind-only switch
    // re-filters the SAME cached list (effect #1 skips the listSessions IPC
    // below when the email didn't change), so we keep `allSessions` intact.
    // Clearing on a kind switch would blank the sidebar for a frame and force a
    // redundant refetch.
    if (emailChanged) setAllSessions([])
    // Sprint 19 PR-1d.2 — confirmations are tied to a session that's
    // about to be left behind; the main process's
    // cancelConfirmationsForSession() will reject the suspended promise
    // when chat.abort fires, but the renderer state should drop the
    // dialog now or it'd briefly render for the previous scope.
    setPendingConfirmations([])
    // task 06-08-chat PR B — live tool steps are scoped to the in-flight turn
    // of the previous scope; drop them so the new scope's panel starts clean
    // (the abort effect tears down the old stream; no more events will land for
    // those message ids).
    setLiveToolCalls(new Map())
    // NOTE: do NOT clear quotaCooldownUntil on scope switch — the
    // upstream quota is global to the CRS account; switching emails / kinds
    // doesn't lift the cap. The cooldown timer below clears it on its
    // own schedule.
  }

  // Mirror activeSessionId into a ref so the email-switch cleanup can
  // read the session id that was active when the email last changed
  // (effect cleanups run BEFORE the next ref-update effect fires, so
  // the ref still holds the previous-commit value at cleanup time).
  const activeSessionRef = useRef<number | null>(null)
  // Sprint 19 — set by newSession() to flag the next send() to first
  // INSERT a fresh ai_chat_sessions row (bypassing the email-keyed
  // reuse lookup), then run the turn against the new sessionId. Self-
  // resets on consumption — a follow-up send() without another
  // newSession() click goes back to the "continue active session" UX.
  // ref (not state) so newSession() stays synchronous and the same-tick
  // send() observes the flag without an extra render.
  const forceNewSessionRef = useRef(false)
  // Sprint 9 §2.3 — throttle the AIDraftStream envelope to once / 500ms.
  // streamedCharsRef tracks the cumulative chunked length; lastStreamFireRef
  // remembers the wall-clock timestamp of the last island.aiDraftStream
  // emit so the ping-island peer doesn't get an envelope per token.
  const streamedCharsRef = useRef(0)
  const lastStreamFireRef = useRef(0)
  // Sprint 10 reviewer L2: session-scoped meta map for the island envelopes
  // (emailId / senderName / subject). `send()` puts on session start; the
  // stream subscription reads on chunk/done; 'done' / 'error' delete. Using
  // a sessionId-keyed map (vs. reading emailIdRef on each chunk) makes the
  // cross-email cumulative-char-leak case structurally impossible — the
  // envelope's emailId comes from the same closure write that created the
  // session, not from whichever email is mounted when the chunk arrives.
  interface SessionIslandMeta {
    emailId: number
    senderName: string | null
    subject: string | null
  }
  const sessionMetaRef = useRef<Map<number, SessionIslandMeta>>(new Map())
  useEffect(() => {
    activeSessionRef.current = activeSessionId
    // 交付文档 §3.1 — remember the active session for the CURRENT scope so a
    // later switch back (email or kind) restores this exact conversation rather
    // than the kind's "latest". Written here (not at each call site) so every
    // path that lands an activeSessionId — initial load, send, selectSession,
    // newSession — records it uniformly. `null` is a meaningful value ("user is
    // on a blank new-session for this scope"), so we store it too.
    activeByScopeRef.current.set(
      scopeKey(emailIdRef.current, backendKindRef.current),
      activeSessionId
    )
  }, [activeSessionId])

  // `syncStreaming` (default true) — whether this refresh should re-derive
  // `streamingMessageId` from the DB's freshest live assistant row. Initial
  // load / email switch / selectSession / tool_call mid-stream all want this
  // so a resumable streaming row is picked up from the SSoT.
  //
  // The `done` (complete) handler passes `false`: task 06-08-chat Bug 1. After
  // the 3c cutover `finalizeMessage` is an async PATCH, while the harness
  // forwards `done` synchronously via the in-process emitter. The done-handler
  // refresh (a GET) races that PATCH and almost always reads the row while it's
  // still `streaming`, which would re-set streamingMessageId right after the
  // handler cleared it — leaving the panel stuck in "Streaming…" until the user
  // hits the abort (X). done has already locally set status=complete +
  // streamingMessageId=null, so this refresh only needs the latest messages
  // (tool rows / token counts), not a streaming re-derive.
  const refresh = useCallback(
    async (sessionId: number, syncStreaming = true): Promise<void> => {
      // task 06-08-chat Bug 1 (codex P0 NIT) — snapshot the navigation
      // generation on entry. If a navigation switch (email / newSession /
      // selectSession / deleteSession-of-active) bumps it while listMessages
      // is in flight, this refresh belongs to a session/email the user has
      // left behind; discarding its setState (below) keeps it from clobbering
      // the freshly-loaded new conversation. Read before the await so the
      // value reflects the navigation state at the moment the refresh was
      // requested.
      const gen = navGenerationRef.current
      const fresh = await mailApi.chat.listMessages(sessionId)
      // Bail before ANY setState if we unmounted or navigated away mid-flight.
      // This MUST precede the terminalIdsRef merge / syncStreaming re-derive
      // below — those guards are message-level and can't tell a stale-session
      // refresh from a current one.
      if (!mountedRef.current || gen !== navGenerationRef.current) return
      const terminal = terminalIdsRef.current
      // MEDIUM finding — merge rather than blindly overwrite. The real harness
      // ordering is forward(done) → await finalizeMessage(), and token / cost /
      // model are only persisted by that finalize. A GET that lands in the gap
      // returns the row still `streaming`, tokens=null, stale content; using it
      // verbatim would roll the local terminal bubble back to streaming and
      // wipe the done reducer's finalContent + usage. So for any fresh row that
      // (a) we already marked terminal AND (b) the DB still reports as
      // streaming/pending (i.e. finalize hasn't landed), keep the local copy.
      // Once the DB row is itself terminal (complete/error/aborted) it's the
      // canonical version — it carries the finalize-written fields — so we take
      // it. Ids absent from `prev` (e.g. very first load) fall through to fresh.
      setMessages((prev) => {
        if (terminal.size === 0) return fresh
        return fresh.map((row) => {
          if (!terminal.has(row.id)) return row
          const isStaleLive = row.status === 'streaming' || row.status === 'pending'
          if (!isStaleLive) return row
          const local = prev.find((m) => m.id === row.id)
          return local ?? row
        })
      })
      // Phase 06-parity — `messages` now reflect `sessionId` (even when `fresh` is empty: a loaded
      // 0-row session). The reload gate uses this to mount the AI SDK runtime only once the active
      // session's load has actually landed (not on a stale empty array during a session switch).
      setMessagesSessionId(sessionId)
      if (syncStreaming) {
        // If the freshest assistant message is still pending/streaming,
        // mark it as the streaming target — protects against a stream
        // event that arrived before `refresh()` resolved.
        //
        // HIGH finding — skip ids we already finished locally. A refresh(true)
        // issued before a terminal event but resolving after it (tool_call /
        // idx=-1 recovery / send / abort all pass syncStreaming=true) would
        // otherwise re-derive streamingMessageId from the not-yet-finalized
        // streaming row and resurrect the just-cleared spinner. The
        // reload-resume path loads with `terminal` empty, so legitimately
        // in-flight rows still resume.
        const liveAssistant = [...fresh]
          .reverse()
          .find(
            (m) =>
              m.role === 'assistant' &&
              (m.status === 'streaming' || m.status === 'pending') &&
              !terminal.has(m.id)
          )
        setStreamingMessageId(liveAssistant ? liveAssistant.id : null)
      }
    },
    [mailApi]
  )

  // 交付文档 §3.1 — tracks which email `allSessions` currently holds. The load
  // effect skips the listSessions IPC when ONLY the kind changed (same email,
  // list already loaded) and re-filters the cached rows instead — avoids a
  // redundant round-trip on every Notion⇄Custom toggle.
  const allSessionsEmailRef = useRef<number | null>(null)

  // --- 1) scope switch (email OR kind) / initial load ----------------------
  // Derived-state resets live in the "Adjusting on prop change" block above;
  // this effect only owns the async load side-effect.
  //
  // 交付文档 §3.1 — keyed on (emailId, backendKind). Both an email switch and a
  // backend-kind switch land here:
  //   - email change → fetch the new email's full session list
  //   - kind-only change (same email) → reuse the cached `allSessions`, no IPC
  // then filter to the current kind, restore the per-scope remembered session
  // (or fall back to the kind's latest), and load its messages.
  useEffect(() => {
    if (emailId === null) {
      allSessionsEmailRef.current = null
      return undefined
    }
    // task 06-08-chat Bug 1 (codex REQUEST CHANGES — HIGH) — the navigation
    // navGeneration bump + terminalIdsRef clear ran in the useLayoutEffect above
    // (synchronously at commit, BEFORE the OLD scope's in-flight refresh can
    // resolve). This passive effect only owns the async load; its refresh()
    // captures the already-bumped gen and is allowed through.
    let cancelled = false
    // Consume the per-scope restore target the layout effect snapshotted (before
    // the activeSessionRef passive write could clobber it). undefined = no memory.
    const restoreTarget = pendingScopeRestoreRef.current
    pendingScopeRestoreRef.current = undefined

    // Pick the target session for THIS (email, kind) scope from a candidate list:
    //   1. the remembered session, IF it still exists in the kind subset
    //   2. else the kind's latest (updated_at DESC → first)
    //   3. else null (no session yet for this kind)
    const pickTarget = (kindSessions: ChatSession[]): number | null => {
      if (typeof restoreTarget === 'number' && kindSessions.some((s) => s.id === restoreTarget)) {
        return restoreTarget
      }
      return kindSessions.length > 0 ? kindSessions[0].id : null
    }

    const applyTarget = async (kindSessions: ChatSession[]): Promise<void> => {
      const target = pickTarget(kindSessions)
      if (target === null) {
        setActiveSessionIdState(null)
        setMessages([])
        setMessagesSessionId(null)
        setStreamingMessageId(null)
        return
      }
      setActiveSessionIdState(target)
      await refresh(target)
    }

    void (async (): Promise<void> => {
      try {
        // Reuse the cached list iff it's for THIS email (kind-only switch);
        // otherwise fetch. allSessions is updated_at DESC from the DB query.
        const fetched =
          allSessionsEmailRef.current === emailId
            ? allSessions
            : await mailApi.chat.listSessions(emailId)
        if (cancelled) return
        if (allSessionsEmailRef.current !== emailId) {
          allSessionsEmailRef.current = emailId
          setAllSessions(fetched)
        }
        const kindSessions = fetched.filter((s) => s.backend_kind === backendKind)
        await applyTarget(kindSessions)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError({ code: 'E_LOAD', message })
      }
    })()
    return (): void => {
      cancelled = true
    }
    // `allSessions` is intentionally NOT a dep: it's read only on the kind-only
    // branch (where the ref already matches emailId so we read the freshest
    // committed value), and adding it would re-run the effect on every
    // setAllSessions (send → refreshSessions), reloading messages spuriously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailId, backendKind, mailApi, refresh])

  // 交付文档 §3.1 — the PUBLIC sessions list is the current-kind subset of the
  // whole-email `allSessions`. ChatSidebar / history therefore only ever show
  // the active agent's conversations, never the other agent's. updated_at DESC
  // order is preserved from the DB query (filter is order-stable).
  const sessions = useMemo(
    () => allSessions.filter((s) => s.backend_kind === backendKind),
    [allSessions, backendKind]
  )

  // --- 2) stream subscription ----------------------------------------------
  useEffect(() => {
    const unsubscribe = mailApi.chat.onStream((envelope) => {
      const currentSession = activeSessionRef.current
      if (currentSession === null || envelope.sessionId !== currentSession) return
      const { messageId, event } = envelope

      // tool_call rows are appended in the main process — refetch
      // rather than maintain a parallel reducer for the side-effect
      // shape. The full message list stays the source of truth.
      if (event.type === 'tool_call') {
        void refresh(envelope.sessionId)
        return
      }

      // Sprint 19 PR-1d.2 — agent harness events. The chat_tool_call
      // audit rows are sidecar to ai_chat_messages (not joined into
      // listMessages), so we DON'T refresh on every tool_use — the
      // renderer reads them via a separate listToolCalls query keyed by
      // messageId once the turn settles.
      //
      // task 06-08-chat PR B — but during the turn we mirror the live
      // transitions into liveToolCalls so the Cowork tool group renders
      // each step as it runs (running spinner → ✓ + duration). The keys are
      // assistant message ids; the renderer reads liveToolCalls[message.id]
      // while streaming and the DB audit rows afterwards. Immutable updates
      // (new Map + new arrays) so React sees the change.
      if (event.type === 'tool_use') {
        setLiveToolCalls((prev) => {
          const next = new Map(prev)
          const existing = next.get(messageId) ?? []
          // Guard against a stray duplicate tool_use envelope re-appending the
          // same toolUseId (the forward path is best-effort).
          if (existing.some((c) => c.toolUseId === event.toolUseId)) return prev
          next.set(messageId, [
            ...existing,
            {
              toolUseId: event.toolUseId,
              name: event.name,
              input: event.input,
              status: 'running',
              durationMs: null
            }
          ])
          return next
        })
        return
      }
      if (event.type === 'tool_result') {
        setLiveToolCalls((prev) => {
          const existing = prev.get(messageId)
          if (!existing) return prev
          const idx = existing.findIndex((c) => c.toolUseId === event.toolUseId)
          if (idx === -1) return prev
          const next = new Map(prev)
          const updatedArr = [...existing]
          updatedArr[idx] = {
            ...updatedArr[idx],
            status: event.status,
            output: event.output,
            errorMessage: event.errorMessage,
            durationMs: event.durationMs
          }
          next.set(messageId, updatedArr)
          return next
        })
        return
      }
      if (event.type === 'pending_confirmation') {
        // Push the dialog request into renderer state. The matching
        // main-process promise stays suspended until confirmTool() fires.
        setPendingConfirmations((prev) => {
          // Duplicate guard: if a stray duplicate envelope arrives (the
          // forward path is best-effort), don't double-show the dialog.
          if (prev.some((p) => p.toolUseId === event.toolUseId)) return prev
          return [
            ...prev,
            {
              sessionId: envelope.sessionId,
              messageId: envelope.messageId,
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
              preview: event.preview,
              tier: event.tier
            }
          ]
        })
        return
      }

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId)
        if (idx === -1) {
          // Streamed event arrived before our optimistic refresh —
          // schedule a refetch and let the next tick render.
          void refresh(envelope.sessionId)
          return prev
        }
        const next = [...prev]
        const updated: ChatMessage = { ...next[idx] }
        switch (event.type) {
          case 'chunk': {
            updated.content = updated.content + event.delta
            updated.status = 'streaming'
            // Sprint 9 §2.3 — throttled AIDraftStream envelope. Cumulative
            // char count is the simplest progress signal ping-island can
            // render in the Phase 1 pill (`…2.4k chars`) without us having
            // to thread a percent estimate through every backend.
            //
            // Sprint 10 L2 — emailId from the session-meta map keyed by the
            // chunk's own sessionId. `emailIdRef.current` could point at a
            // different email if the user switched mid-stream; the map
            // entry was written when this session started so it stays bound
            // to the originating email for the session's lifetime.
            streamedCharsRef.current = updated.content.length
            const meta = sessionMetaRef.current.get(envelope.sessionId)
            if (meta && Date.now() - lastStreamFireRef.current >= 500) {
              lastStreamFireRef.current = Date.now()
              mailApi.island.aiDraftStream({
                emailId: meta.emailId,
                streamedChars: streamedCharsRef.current
              })
            }
            break
          }
          case 'thinking':
            // task 06-08-chat 需求 5 — extended-thinking delta. Append to the
            // message's `thinking` (kept separate from `content`; rendered in the
            // collapsible block above the answer). Reload reads the finalized
            // buffer from the DB (harness persists it on终态), so this is the
            // live-stream-only path. status stays whatever it was (still streaming).
            updated.thinking = (updated.thinking ?? '') + event.delta
            break
          case 'usage':
            updated.tokens_input = event.inputTokens
            updated.tokens_output = event.outputTokens
            updated.cost_usd = event.costUsd
            if (event.model !== null) updated.model = event.model
            break
          case 'done':
            updated.status = 'complete'
            if (event.finalContent && event.finalContent.length > 0) {
              updated.content = event.finalContent
            }
            if (event.model !== null) updated.model = event.model
            break
          case 'error':
            updated.status = 'error'
            updated.error_message = event.message
            break
        }
        next[idx] = updated
        return next
      })

      if (event.type === 'done') {
        // task 06-08-chat Bug 1 (codex follow-up) — record the terminal id so
        // any refresh(true) still in flight (or the done-path refresh below)
        // can't re-derive this as streaming or overwrite the local complete
        // bubble with a not-yet-finalized DB row. See terminalIdsRef + refresh.
        terminalIdsRef.current.add(messageId)
        setStreamingMessageId(null)
        // Sprint 5 #3 — clear the retry buffer once the turn finished cleanly.
        setLastFailedInput(null)
        // SSoT refresh (catch tool rows + token counts in one network query).
        // task 06-08-chat Bug 1 — pass syncStreaming=false: the finalize PATCH
        // races this GET after the 3c cutover, so re-deriving streamingMessageId
        // here would resurrect the just-cleared streaming state.
        void refresh(envelope.sessionId, false)
        // Sprint 9 §2.3 + Sprint 10 reviewer L1/L3 — final island envelope
        // sequence. L1: emit one trailing AIDraftStream with the final char
        // count so the Phase 1 pill ends on a truthful number (the 500 ms
        // throttle would otherwise drop the last burst of chunks). L3:
        // senderName / subject come from the session-meta map populated at
        // send() time, so the ping-island Ready card reads `AI 草稿就绪 /
        // <real sender>` instead of `... / —`.
        const meta = sessionMetaRef.current.get(envelope.sessionId)
        if (meta) {
          const preview = (event.finalContent || '').slice(0, 240)
          // Trailing flush (L1) — only if we've streamed anything, to avoid a
          // bogus 0-char stream emit on backends that send `done` straight
          // after `start` with no chunks (rare but possible).
          if (streamedCharsRef.current > 0) {
            mailApi.island.aiDraftStream({
              emailId: meta.emailId,
              streamedChars: streamedCharsRef.current
            })
          }
          mailApi.island.aiDraftReady({
            emailId: meta.emailId,
            senderName: meta.senderName,
            subject: meta.subject,
            preview
          })
          sessionMetaRef.current.delete(envelope.sessionId)
        }
      } else if (event.type === 'error') {
        // task 06-08-chat Bug 1 (codex follow-up) — same terminal guard as the
        // done path: a refresh(true) already in flight when the error lands
        // must not re-derive the errored row back into the streaming target.
        terminalIdsRef.current.add(messageId)
        setStreamingMessageId(null)
        setError({ code: event.code, message: event.message })
        // Sprint 5 state machine #4 — engage cooldown on quota cap.
        //
        // task 06-15 Bug 1 — notion-agent trust-rule rate limit
        // (E_NOTION_AGENT_RATE_LIMIT, CLI exit 75) NO LONGER engages the
        // forced backoff. Per product call it's a non-blocking reminder now:
        // the error banner (chat.error.agentRateLimit) tells the user Notion's
        // anti-automation guard tripped and to wait, but send stays enabled —
        // a hard disable + countdown was too heavy a hand for a guard the user
        // can simply pace around. So only the real upstream quota cap
        // (E_QUOTA, custom-api only) drives the cooldown below.
        //
        // task 06-15 Bug 2 — record the backend kind that owns the cooldown so
        // AIChatPanel can scope it to that tab. E_QUOTA is an Anthropic-account
        // cap that only the custom-api backend can hit, so the cooldown must
        // not leak into the Notion Agent tab.
        if (event.code === 'E_QUOTA') {
          setQuotaCooldownUntil(Date.now() + QUOTA_COOLDOWN_MS)
          // backendKindRef (not the closure `backendKind`): this subscribe
          // effect captures props at mount time and never re-subscribes, so
          // the ref is the only source of the CURRENT tab here.
          setQuotaCooldownKind(backendKindRef.current)
        }
        // L2 cleanup — session won't produce more events; drop the meta entry
        // to keep the map from growing across long sessions with frequent retries.
        sessionMetaRef.current.delete(envelope.sessionId)
      }
    })
    return unsubscribe
  }, [mailApi, refresh])

  // --- 2.5) quota cooldown self-clear timer --------------------------------
  // Single timer that wakes when the cooldown lifts; safe to schedule
  // because cooldown values are monotonically increasing and we only
  // store one at a time. We always go through setTimeout (even when the
  // delay is 0) so the state update lands on a fresh tick — calling
  // setState directly in the effect body trips `react-hooks/set-state-in-effect`.
  useEffect(() => {
    if (quotaCooldownUntil === null) return undefined
    const remaining = Math.max(0, quotaCooldownUntil - Date.now())
    const t = setTimeout(() => {
      setQuotaCooldownUntil(null)
      // task 06-15 Bug 2 — clear the owning kind in lock-step so the gate
      // can never see a live kind with a lifted timestamp.
      setQuotaCooldownKind(null)
    }, remaining)
    return (): void => clearTimeout(t)
  }, [quotaCooldownUntil])

  // --- 2.6) quota cooldown localStorage sync (Sprint 6 Day 1) ---------------
  // Mirror the in-memory value into localStorage so a reload inside the
  // window restores the throttle. Read happens via the useState lazy
  // initializer above; this effect handles every subsequent update.
  //
  // Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — skip the first
  // mount. The lazy initializer already read from localStorage, so the
  // mount-time effect would just write back the same value (one redundant
  // `setItem` per hook lifetime). Trivial cost individually, but the panel
  // remounts on every email switch, so this is a per-click win.
  const firstCooldownEffectRef = useRef(true)
  useEffect(() => {
    if (firstCooldownEffectRef.current) {
      firstCooldownEffectRef.current = false
      return
    }
    try {
      if (typeof localStorage === 'undefined') return
      if (quotaCooldownUntil === null) {
        localStorage.removeItem(QUOTA_COOLDOWN_STORAGE_KEY)
        localStorage.removeItem(QUOTA_COOLDOWN_KIND_KEY)
      } else {
        localStorage.setItem(QUOTA_COOLDOWN_STORAGE_KEY, String(quotaCooldownUntil))
        // task 06-15 Bug 2 — persist the owning kind alongside so a reload
        // inside the window restores a tab-scoped (not global) throttle.
        if (quotaCooldownKind !== null) {
          localStorage.setItem(QUOTA_COOLDOWN_KIND_KEY, quotaCooldownKind)
        } else {
          localStorage.removeItem(QUOTA_COOLDOWN_KIND_KEY)
        }
      }
    } catch {
      // localStorage unavailable — cooldown still works in-memory.
    }
  }, [quotaCooldownUntil, quotaCooldownKind])

  // --- 3) abort on scope switch (email OR kind) / unmount ------------------
  // `activeSessionRef.current` may still be null at effect-run time (the
  // session id arrives from the async `listSessions` promise) — reading
  // the ref inside the cleanup closure gets the latest value at the
  // moment the scope actually switches or the panel unmounts.
  //
  // 交付文档 §3.1 — also keyed on backendKind so a kind switch tears down the
  // OLD kind's in-flight stream, exactly like an email switch (the user's spec:
  // "切 kind 应像 email 切换一样 abort"). The cleanup runs before the next
  // render's effects re-sync activeSessionRef, so it still reads the pre-switch
  // session id.
  useEffect(() => {
    return (): void => {
      const sid = activeSessionRef.current
      if (sid !== null) mailApi.chat.abort(sid)
    }
  }, [emailId, backendKind, mailApi])

  // --- 4) public actions ---------------------------------------------------

  // Sprint 14 PR A — pull a fresh sessions list for the active email.
  // Triggered after each send so a newly-created session row (e.g.
  // after `newSession()` + first send) appears in the sidebar without
  // forcing an email re-mount. Best-effort: errors stay silent because
  // the sidebar is non-critical UX. Defined before `send` so the send
  // useCallback's dep array can reference it without a TDZ.
  const refreshSessions = useCallback(async (): Promise<void> => {
    if (emailId === null) return
    // task 06-08-chat Bug 1 (codex LOW-1) — refreshSessions is an email-scoped
    // async write to the sidebar that, unlike refresh(), didn't ride the
    // navGeneration guard. A navigation switch (email change / newSession /
    // selectSession / deleteSession-of-active) mid-flight would let the OLD
    // email's listSessions resolve and setSessions() the previous email's
    // history into the NEW email's sidebar (messages/spinner are protected by
    // refresh's own guard; only the sidebar leaked). Snapshot the generation on
    // entry + bail after the await if it moved (or we unmounted).
    const gen = navGenerationRef.current
    try {
      const fresh = await mailApi.chat.listSessions(emailId)
      if (!mountedRef.current || gen !== navGenerationRef.current) return
      // 交付文档 §3.1 — write the WHOLE-email list; the public `sessions` memo
      // re-filters to the active kind. Keep the email-tracking ref in sync so the
      // load effect's kind-only branch reuses this freshest snapshot.
      allSessionsEmailRef.current = emailId
      setAllSessions(fresh)
    } catch {
      // Sidebar is non-critical; swallow.
    }
  }, [emailId, mailApi])

  const send = useCallback(
    async (input: SendChatInput): Promise<ChatStartResult> => {
      if (emailId === null) {
        throw new Error('useEmailChat.send: no active email (emailId is null)')
      }
      setError(null)
      // Snapshot the email this turn targets BEFORE awaiting. If the user
      // switches emails (or the hook unmounts) while `chat.start()` is in
      // flight, the snapshot diverges from `emailIdRef.current` and we
      // know to abort the stranded session instead of touching state for
      // the wrong email (codex High carry-forward).
      const myEmail = emailId
      // codex r4 [HIGH] — snapshot the navigation generation BEFORE the first
      // await, same as refresh()'s `gen`. navGenerationRef bumps on EITHER
      // emailId OR backendKind changing (the useLayoutEffect above), so a
      // same-email KIND switch counts as a navigation event the bare `myEmail`
      // check below can't catch. Reading it pre-await captures the nav state at
      // send time; the post-await guards discard a turn whose scope the user
      // left behind, preventing the stale kind's session from being written
      // into the new kind's scope (串台).
      const myGen = navGenerationRef.current
      // Sprint 19 — if the user just clicked "+ 新建会话" (newSession() set
      // forceNewSessionRef), INSERT a fresh ai_chat_sessions row first so
      // this turn lands in a brand-new session. Backend info comes from
      // SendChatInput (BackendSelector state lives in AIChatPanel; not
      // available at newSession() time, so the INSERT is deferred to here).
      // Reset the flag BEFORE the await so a throw doesn't spin retries.
      // Errors propagate to the send() caller and surface in the chat
      // error banner — better than silently writing to the resurrected
      // session, which is exactly the bug we're fixing.
      if (forceNewSessionRef.current) {
        forceNewSessionRef.current = false
        const newSess = await mailApi.chat.newSession({
          emailId,
          backendKind: input.backendKind,
          backendModel: input.backendModel ?? null,
          backendAgentPageId: input.backendAgentPageId ?? null
        })
        // codex r4 [HIGH] — if the scope moved (email switch OR same-email kind
        // switch) while newSession was in flight, the freshly-INSERTed row
        // belongs to a scope the user has left. newSession() only created an
        // empty ai_chat_sessions row (no stream started yet), so there's
        // nothing to abort; just skip chat.start and return ids reflecting that
        // row WITHOUT touching any streaming/active state for the current scope.
        if (
          !mountedRef.current ||
          emailIdRef.current !== myEmail ||
          myGen !== navGenerationRef.current
        ) {
          return { sessionId: newSess.id, userMessageId: 0, assistantMessageId: 0 }
        }
        activeSessionRef.current = newSess.id
        setActiveSessionIdState(newSess.id)
      }
      // R3 — @mention: force-activate any @skill for THIS turn's scope
      // (email:<id>:<kind>), then thread the scope's activation list into start() so the
      // runtime advertises it for this turn only. Scope-keyed (not a global list) so a
      // mention in this email/kind never leaks into another email, kind, or the General
      // Agent surface (they share one runtime).
      const skillScope = `email:${myEmail}:${input.backendKind}`
      const activatedSkills = applySkillMentions(skillScope, input.message)
      const result = await mailApi.chat.start({
        emailId,
        message: input.message,
        backendKind: input.backendKind,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: input.backendAgentPageId ?? null,
        // Sprint 19 — thread the active session id so dispatcher lands in
        // the freshly-created session row (set above when forceNewSessionRef
        // was true, or by a previous send()'s setActiveSessionIdState).
        // Ref read (not state) to avoid stale closure across rapid sends.
        sessionId: activeSessionRef.current,
        // task 06-08-chat 需求 5 — per-turn thinking toggle (AIChatPanel reads it
        // from the persisted Composer state at send time).
        thinking: input.thinking,
        activatedSkills
      })
      if (
        !mountedRef.current ||
        emailIdRef.current !== myEmail ||
        myGen !== navGenerationRef.current
      ) {
        // Email moved on, hook unmounted, OR the scope's KIND switched (same
        // email, different agent) before the dispatcher returned. A same-email
        // kind switch also bumps navGenerationRef, so `myGen !== current`
        // covers the path the bare `myEmail` check misses. Abort the stranded
        // session and skip the state mutations — the current scope's panel must
        // not flip to streaming on a sessionId it didn't subscribe to.
        mailApi.chat.abort(result.sessionId)
        // Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — we no
        // longer set `lastFailedInput` BEFORE the stranded check (the
        // earlier Sprint 5 ordering had a tiny race window where a stranded
        // send would leave the closure-captured input visible to retryLast,
        // even though `error !== null` gating made it unreachable in
        // practice). After move + post-check return, lastFailedInput stays
        // at its prior value — null on first send, or the previous send's
        // input which is still the right thing to retry.
        return result
      }
      // Capture the input AFTER the stranded check so it only persists
      // when this send is committed to the active email. Cleared once we
      // observe a `done` event on the stream subscription (success) or
      // promoted to retry on a transient error.
      setLastFailedInput(input)
      setActiveSessionIdState(result.sessionId)
      activeSessionRef.current = result.sessionId
      setStreamingMessageId(result.assistantMessageId)
      // Sprint 9 §2.3 — fire AIDraftStart envelope. Reset throttle counters
      // before the first stream chunk arrives; the main side fails open if
      // ping-island isn't running.
      // Sprint 10 L2/L3 — populate the session-meta map so the stream
      // subscription can read sessionId → {emailId, senderName, subject}
      // without trusting emailIdRef across email switches, and so the Ready
      // envelope can label the card with the real sender.
      streamedCharsRef.current = 0
      lastStreamFireRef.current = 0
      const senderName = input.senderName ?? null
      const subject = input.subject ?? null
      sessionMetaRef.current.set(result.sessionId, {
        emailId: myEmail,
        senderName,
        subject
      })
      mailApi.island.aiDraftStart({
        emailId: myEmail,
        senderName,
        subject,
        prompt: input.message
      })
      await refresh(result.sessionId)
      // Sprint 14 PR A — pull the sessions list so the sidebar reflects
      // the just-bumped updated_at (and any newly-created session row
      // from a post-newSession() send). Best-effort + fire-and-forget;
      // refreshSessions swallows errors. refreshSessions's emailId
      // closure was captured at send-time — matches `myEmail` above, so
      // a stranded send that flunked the post-await guard above never
      // reaches this line.
      void refreshSessions()
      return result
    },
    [emailId, mailApi, refresh, refreshSessions]
  )

  const abortCurrent = useCallback(() => {
    const sid = activeSessionRef.current
    if (sid === null) return
    mailApi.chat.abort(sid)
    // Sprint 4 review (codex M carry-forward): the IPC abort doesn't push a
    // `chat:stream` event back, so without a local update the panel would
    // stay in `isStreaming = true` until the next event lands (or never,
    // if the backend died). Clear the streaming id immediately and pull
    // the canonical `aborted` row off the SSoT so the UI reflects state.
    //
    // task 06-08-chat Bug 1 (codex follow-up) — mark the in-flight id terminal
    // BEFORE the refresh below (which passes syncStreaming=true). Without this,
    // a refresh that lands before the backend wrote the `aborted` row would
    // see the still-streaming row and re-set streamingMessageId, resurrecting
    // the spinner the user just dismissed. Functional updater so we read the
    // latest streamingMessageId without widening this callback's deps.
    setStreamingMessageId((prev) => {
      if (prev !== null) terminalIdsRef.current.add(prev)
      return null
    })
    // Sprint 10 L2 — drop the meta entry; no more envelopes will fire for
    // this session.
    sessionMetaRef.current.delete(sid)
    void refresh(sid)
  }, [mailApi, refresh])

  const clearError = useCallback(() => setError(null), [])

  // Sprint 13 — "+ New conversation" affordance. Resets renderer-side
  // session state so the next `send()` opens a fresh session for the
  // current email. Aborts any in-flight stream first so its `done` event
  // doesn't land on a freshly-blanked message list. The backend doesn't
  // (yet) honour a `forceNew` flag; on the next `chat.start` it'll create
  // a new SQLite row because the renderer no longer carries activeSessionId.
  //
  // Sprint 14 PR A — the history sidebar surfaces a switcher. The
  // previous session row is preserved in ai_chat.db and shows up in the
  // sidebar; user can switch back via `selectSession` below.
  const newSession = useCallback(() => {
    const sid = activeSessionRef.current
    if (sid !== null) mailApi.chat.abort(sid)
    sessionMetaRef.current.delete(sid ?? -1)
    setActiveSessionIdState(null)
    activeSessionRef.current = null
    setMessages([])
    setMessagesSessionId(null)
    setStreamingMessageId(null)
    setError(null)
    setLastFailedInput(null)
    // R3 — drop @mention activations for THIS scope only (email:<id>:<kind>); other
    // emails' / the General surface's activations are namespaced and untouched.
    useSkillActivation.getState().clearScope(`email:${emailId}:${backendKind}`)
    // task 06-08-chat PR B — drop any in-flight turn's live tool steps.
    setLiveToolCalls(new Map())
    // task 06-08-chat Bug 1 (codex follow-up) — a fresh conversation starts
    // with no terminal history; clear so a future genuinely-streaming row in
    // the new session isn't suppressed by a stale id from the old one.
    terminalIdsRef.current.clear()
    // task 06-08-chat Bug 1 (codex P0 NIT) — newSession is a navigation event
    // and crucially CLEARS terminalIdsRef above, so the message-level guard
    // can't help here. Bump the generation so a refresh(true) still in flight
    // for the old session (send / chunk recovery / tool_call / done) is
    // discarded on resolve instead of re-populating the just-blanked list +
    // resurrecting the old streaming target.
    navGenerationRef.current += 1
    // Sprint 19 PR-1d.2 — leftover dialogs from the previous session must
    // not survive the abort (main-process side already cancels the
    // suspended promise; the renderer state must mirror that to avoid a
    // dead dialog blocking the user).
    setPendingConfirmations([])
    // Sprint 19 — flag the next send() to INSERT a fresh ai_chat_sessions
    // row first. Without this the next send falls through to
    // getOrCreateSession in the dispatcher and resurrects the previous
    // session, defeating the "+ 新建会话" click. backend info isn't known
    // here (BackendSelector lives in AIChatPanel; send() receives it
    // through SendChatInput) so we defer the actual INSERT to send().
    forceNewSessionRef.current = true
  }, [mailApi, emailId, backendKind])

  // Sprint 19 PR-1d.2 — Confirmation dialog reply. The harness IPC fires
  // FIRST and unblocks the suspended main-process promise (闭环不变); only the
  // VISUAL removal is deferred.
  //
  // task 06-08-chat PR D (§4.3) — instead of filtering the entry out
  // immediately on `ok:true`, we mark it `resolved` (keeping it in the array)
  // so ConfirmToolDialog can render a "decided" banner (✓ authorized / ✕
  // rejected). After ~1.3s the entry is filtered out for real. The IPC call is
  // unchanged and still awaited up front, so the harness is unblocked the
  // moment the user clicks — the lingering card is purely cosmetic.
  //
  // Cleanup safety: navigation / email-switch / new-session call
  // `setPendingConfirmations([])`, so a stray timer's filter just no-ops
  // (the toolUseId is already gone). No clearTimeout needed.
  const confirmTool = useCallback(
    async (
      toolUseId: string,
      approved: boolean,
      editedInput?: unknown
    ): Promise<{ ok: true } | { ok: false; code: string; message: string }> => {
      const result = await mailApi.chat.confirmTool(toolUseId, approved, editedInput)
      if (result.ok) {
        // Mark resolved (card lingers showing the decided banner)…
        setPendingConfirmations((prev) =>
          prev.map((p) =>
            p.toolUseId === toolUseId ? { ...p, resolved: approved ? 'confirmed' : 'rejected' } : p
          )
        )
        // …then remove it for real after the banner has been read.
        setTimeout(() => {
          setPendingConfirmations((prev) => prev.filter((p) => p.toolUseId !== toolUseId))
        }, 1300)
      }
      return result
    },
    [mailApi]
  )

  // Sprint 14 PR B — edit a user message and re-stream. The hook owns
  // the activeSession + streamingMessageId state machine, so editMessage
  // mirrors send()'s post-IPC bookkeeping (clear error / set streaming
  // target / refresh from SSoT). Differences from send:
  //   - no SendChatInput.senderName/subject — island envelopes are an
  //     onboarding signal for the first send of a turn; an edit is a
  //     mid-turn correction, not a new draft event
  //   - no chat.start; the backend's `editChatMessage` truncates +
  //     appends + re-streams in one IPC call
  //   - no stranded-send guard — editMessage requires an active session
  //     that already belongs to the current email; switching emails
  //     would have nulled activeSessionId before the user could click
  //     edit
  const editMessage = useCallback(
    async (input: EditChatInput): Promise<ChatStartResult> => {
      if (activeSessionId === null) {
        throw new Error('useEmailChat.editMessage: no active session')
      }
      setError(null)
      // codex r4 [HIGH] — snapshot the navigation generation + email BEFORE the
      // editMessage IPC, same as send(). A same-email KIND switch (or email
      // switch) while the IPC is in flight bumps navGenerationRef; without a
      // post-await guard the re-streamed session would be written into the new
      // scope (串台). The comment block above ("no stranded-send guard")
      // assumed only email switches null activeSessionId — but a kind switch
      // also leaves the IPC resolving against a scope the user has left.
      const myEmail = emailIdRef.current
      const myGen = navGenerationRef.current
      // R3 — re-apply @mention activation from the edited content into this scope.
      const skillScope = `email:${myEmail}:${input.backendKind}`
      const activatedSkills = applySkillMentions(skillScope, input.newContent)
      const result = await mailApi.chat.editMessage({
        sessionId: activeSessionId,
        editingMessageId: input.messageId,
        newContent: input.newContent,
        backendKind: input.backendKind,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: input.backendAgentPageId ?? null,
        // task 06-08-chat 需求 5 — per-turn thinking toggle for the re-stream.
        thinking: input.thinking,
        activatedSkills
      })
      if (
        !mountedRef.current ||
        emailIdRef.current !== myEmail ||
        myGen !== navGenerationRef.current
      ) {
        // Scope moved on (email switch OR same-email kind switch) before the
        // re-stream returned. Abort the stranded session and skip the state
        // mutations — the current scope must not flip to streaming on a
        // sessionId it didn't subscribe to.
        mailApi.chat.abort(result.sessionId)
        return result
      }
      setStreamingMessageId(result.assistantMessageId)
      activeSessionRef.current = result.sessionId
      // Refresh the message list so the truncated tail + the freshly
      // appended user row land in `messages` before the first stream
      // chunk arrives. listMessages is the authoritative ordering.
      await refresh(result.sessionId)
      return result
    },
    [activeSessionId, mailApi, refresh]
  )

  // Sprint 14 PR J — delete a session. Cascades to messages on the
  // backend via the chat_db FK; on the renderer we abort any in-flight
  // stream first, scrub the local sessions list, and reset active
  // session state when the deleted session was active.
  const deleteSession = useCallback(
    (sessionId: number): void => {
      if (sessionId === activeSessionRef.current) {
        mailApi.chat.abort(sessionId)
        sessionMetaRef.current.delete(sessionId)
        // task 06-08-chat Bug 1 (codex P0 NIT) — only bump when the deleted
        // session WAS the active one (the branch that clears messages /
        // streaming, i.e. an actual navigation away). Deleting a non-active
        // sidebar row leaves the active conversation untouched, so an
        // in-flight refresh for it stays legitimate and must NOT be discarded.
        navGenerationRef.current += 1
        setActiveSessionIdState(null)
        activeSessionRef.current = null
        setMessages([])
        setMessagesSessionId(null)
        setStreamingMessageId(null)
        setLastFailedInput(null)
        setError(null)
        // task 06-08-chat PR B — the active session is being deleted; clear its
        // live tool steps along with the rest of the renderer state.
        setLiveToolCalls(new Map())
      }
      mailApi.chat.deleteSession(sessionId)
      // 交付文档 §3.1 — scrub from the whole-email list; the public `sessions`
      // memo re-derives the kind subset. pickTarget already guards a restore
      // against a since-deleted id, so the per-scope memory needs no cleanup.
      setAllSessions((cur) => cur.filter((s) => s.id !== sessionId))
    },
    [mailApi]
  )

  // Sprint 14 PR A — switch the renderer to a different session for the
  // current email (sidebar click). Aborts any in-flight stream on the
  // currently-active session, loads the target session's messages, and
  // re-points `activeSessionId`. If the target session has a streaming
  // assistant message still in flight on the backend, `refresh()` will
  // surface it as the new streamingMessageId so the panel resumes the
  // live stream (stream subscription is sessionId-keyed, so the existing
  // listener picks it up automatically).
  const selectSession = useCallback(
    async (sessionId: number): Promise<void> => {
      if (emailId === null) return
      if (sessionId === activeSessionRef.current) return
      const prev = activeSessionRef.current
      if (prev !== null) {
        mailApi.chat.abort(prev)
        sessionMetaRef.current.delete(prev)
      }
      // task 06-08-chat Bug 1 (codex P0 NIT) — switching sessions is a
      // navigation event. Bump BEFORE this callback's own refresh(sessionId)
      // below (which captures the post-bump gen and is allowed through) so a
      // refresh(true) still resolving for the session we just left can't
      // overwrite the incoming session's messages / streaming target.
      navGenerationRef.current += 1
      setError(null)
      setLastFailedInput(null)
      setStreamingMessageId(null)
      // task 06-08-chat PR B — leaving the current session drops its live tool
      // steps; the incoming session reads its own DB audit rows via refresh().
      setLiveToolCalls(new Map())
      setActiveSessionIdState(sessionId)
      activeSessionRef.current = sessionId
      try {
        await refresh(sessionId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError({ code: 'E_LOAD', message })
      }
    },
    [emailId, mailApi, refresh]
  )

  // Phase 06a (cutover) — adopt an ai-sdk session the panel created out-of-band (renderer IPC,
  // backend_kind='ai-sdk') so the legacy hook state stays the SSoT for history / title / reload.
  // Unlike selectSession this runs NO IPC / refresh: the session is freshly created + empty (0 rows),
  // and the AI SDK runtime owns the live turns; messagesSessionId = id makes the reload gate read
  // "ready" without a listMessages round-trip. The row persists via the gateway dual-write once the
  // first turn finishes; a later refreshSessions reconciles it with the DB.
  const adoptSession = useCallback((session: ChatSession): void => {
    setAllSessions((cur) => (cur.some((s) => s.id === session.id) ? cur : [session, ...cur]))
    setActiveSessionIdState(session.id)
    activeSessionRef.current = session.id
    setMessages([])
    setMessagesSessionId(session.id)
    setStreamingMessageId(null)
    setError(null)
  }, [])

  // Sprint 5 #3 — Retry CTA. Only available when:
  //   1. we have a captured failed input (set in send())
  //   2. the error is "retriable" (network / upstream / agent timeout)
  // Other errors (E_NO_LLM_KEY / E_INVALID_ARG / E_MODEL_UNSUPPORTED) are
  // user-config issues that a blind retry won't fix — surfacing the button
  // there would mislead.
  const isRetriableError = error !== null && RETRIABLE_ERROR_CODES.has(error.code)
  const retryLast =
    isRetriableError && lastFailedInput !== null
      ? async (): Promise<void> => {
          try {
            await send(lastFailedInput)
          } catch {
            // send() captures errors via setError; nothing extra here.
          }
        }
      : null

  return {
    messages,
    messagesSessionId,
    streamingMessageId,
    isStreaming: streamingMessageId !== null,
    error,
    activeSessionId,
    send,
    abortCurrent,
    clearError,
    newSession,
    retryLast,
    quotaCooldownUntil,
    quotaCooldownKind,
    sessions,
    selectSession,
    adoptSession,
    editMessage,
    deleteSession,
    pendingConfirmations,
    confirmTool,
    liveToolCalls,
    skillScopeKey: `email:${emailId ?? 'null'}:${backendKind}`
  }
}

// Sprint 5 #3 — retry surface only on transient upstream issues. The list
// matches the dispatcher's surfaceable network / upstream codes from
// custom_api + notion_agent backends. E_ABORTED is intentionally absent —
// aborts are user-initiated and shouldn't auto-re-fire.
//
// Sprint 6 Day 1 (opus LOW carry-forward) — broaden the set:
//   - E_NOTION_AGENT_FAIL: notion-agent CLI exited non-zero on a mid-stream
//     transient (Notion API rate, network blip). The dispatcher passes this
//     through unwrapped; retry usually succeeds on the next attempt.
//   - overloaded_error / rate_limit_error / api_error: raw Anthropic
//     mid-stream `error.type` strings that the custom_api backend can emit
//     verbatim when the upstream sends an SSE `error` chunk instead of a
//     graceful end. "Claude is overloaded" is the headline case — retry
//     typically clears within 30s.
//
// NOT here on purpose: E_NOTION_AGENT_RATE_LIMIT (CLI exit 75 / trust-rule).
// Notion reports isRetryable:false — an immediate re-fire deepens the
// anti-automation ban, so there's no Retry button. task 06-15 Bug 1: it no
// longer engages the quota cooldown either (that was too heavy a hand for a
// guard the user can pace around) — it's a plain banner reminder now, with
// send left enabled (see the error-event handler above).
const RETRIABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'E_NETWORK',
  'E_UPSTREAM',
  'E_NOTION_AGENT_NETWORK',
  'E_NOTION_AGENT_TIMEOUT',
  'E_NOTION_AGENT_FAIL',
  'E_BACKEND_CRASH',
  'overloaded_error',
  'rate_limit_error',
  'api_error'
])
