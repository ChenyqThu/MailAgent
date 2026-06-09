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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useMailApi } from './useMailApi'
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
  /** Sprint 14 PR A — all sessions for the current email, ordered by
   *  updated_at DESC. Surfaced to the history sidebar; refreshed on email
   *  switch + after each successful `send()` (which may have created a
   *  fresh session row). */
  sessions: ChatSession[]
  /** Sprint 14 PR A — switch the renderer to a different session for the
   *  current email. Aborts any in-flight stream, loads the target session's
   *  messages, and points `activeSessionId` at the new session. */
  selectSession: (sessionId: number) => Promise<void>
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

export function useEmailChat(emailId: number | null): UseEmailChatReturn {
  const mailApi = useMailApi()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeSessionId, setActiveSessionIdState] = useState<number | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [lastEmailId, setLastEmailId] = useState<number | null>(emailId)
  // Sprint 14 PR A — sessions for the current email; surfaced to the
  // history sidebar. Loaded by effect #1 on email switch, refreshed
  // after each successful send (which may have created a new row).
  const [sessions, setSessions] = useState<ChatSession[]>([])
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
  useLayoutEffect(() => {
    navGenerationRef.current += 1
    terminalIdsRef.current.clear()
  }, [emailId])

  // React 19 "Adjusting state on prop change" (react.dev/learn/you-might-not-need-an-effect).
  // When emailId switches, reset derived state synchronously inside
  // render rather than via an effect — keeps the renderer from showing
  // a frame of stale data, and avoids the `react-hooks/set-state-in-effect`
  // lint that would fire if we did the same work in useEffect.
  if (lastEmailId !== emailId) {
    setLastEmailId(emailId)
    setError(null)
    setMessages([])
    setActiveSessionIdState(null)
    setStreamingMessageId(null)
    setLastFailedInput(null)
    // Sprint 14 PR A — sessions are email-scoped; clear so the sidebar
    // doesn't briefly show the previous email's history while effect #1
    // re-fetches.
    setSessions([])
    // Sprint 19 PR-1d.2 — confirmations are tied to a session that's
    // about to be left behind; the main process's
    // cancelConfirmationsForSession() will reject the suspended promise
    // when chat.abort fires, but the renderer state should drop the
    // dialog now or it'd briefly render for the previous email.
    setPendingConfirmations([])
    // task 06-08-chat PR B — live tool steps are scoped to the in-flight turn
    // of the previous email; drop them so the new email's panel starts clean
    // (the abort effect tears down the old stream; no more events will land for
    // those message ids).
    setLiveToolCalls(new Map())
    // NOTE: do NOT clear quotaCooldownUntil on email switch — the
    // upstream quota is global to the CRS account; switching emails
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

  // --- 1) email switch / initial load --------------------------------------
  // Derived-state resets live in the "Adjusting on prop change" block
  // above; this effect only owns the async load side-effect.
  useEffect(() => {
    if (emailId === null) return undefined
    // task 06-08-chat Bug 1 (codex REQUEST CHANGES — HIGH) — the email-switch
    // navGeneration bump + terminalIdsRef clear moved to the useLayoutEffect
    // above so they run synchronously at commit time, BEFORE the OLD email's
    // in-flight refresh can resolve. This passive effect now only owns the
    // async load. Because passive effects run after layout effects, the
    // refresh(latest.id) below captures the already-bumped gen and is allowed
    // through (it doesn't kill itself).
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const fetched = await mailApi.chat.listSessions(emailId)
        if (cancelled) return
        // Sprint 14 PR A — persist to state so the sidebar can render
        // them; order is already updated_at DESC from the DB query.
        setSessions(fetched)
        if (fetched.length === 0) {
          setActiveSessionIdState(null)
          setMessages([])
          setStreamingMessageId(null)
          return
        }
        const latest = fetched[0]
        setActiveSessionIdState(latest.id)
        await refresh(latest.id)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError({ code: 'E_LOAD', message })
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [emailId, mailApi, refresh])

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
        // notion-agent trust-rule rate limit (CLI exit 75) reuses the same
        // cooldown substrate: Notion's anti-automation guard reports
        // isRetryable:false with retry_after≈300s, so the only safe response
        // is a forced backoff (disable send + countdown). An immediate retry
        // deepens the ban — hence E_NOTION_AGENT_RATE_LIMIT is deliberately
        // absent from RETRIABLE_ERROR_CODES (no Retry button).
        if (event.code === 'E_QUOTA' || event.code === 'E_NOTION_AGENT_RATE_LIMIT') {
          setQuotaCooldownUntil(Date.now() + QUOTA_COOLDOWN_MS)
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
    const t = setTimeout(() => setQuotaCooldownUntil(null), remaining)
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
      } else {
        localStorage.setItem(QUOTA_COOLDOWN_STORAGE_KEY, String(quotaCooldownUntil))
      }
    } catch {
      // localStorage unavailable — cooldown still works in-memory.
    }
  }, [quotaCooldownUntil])

  // --- 3) abort on email switch / unmount ----------------------------------
  // `activeSessionRef.current` may still be null at effect-run time (the
  // session id arrives from the async `listSessions` promise) — reading
  // the ref inside the cleanup closure gets the latest value at the
  // moment the email actually switches or the panel unmounts.
  useEffect(() => {
    return (): void => {
      const sid = activeSessionRef.current
      if (sid !== null) mailApi.chat.abort(sid)
    }
  }, [emailId, mailApi])

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
      setSessions(fresh)
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
        activeSessionRef.current = newSess.id
        setActiveSessionIdState(newSess.id)
      }
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
        thinking: input.thinking
      })
      if (!mountedRef.current || emailIdRef.current !== myEmail) {
        // Email moved on (or hook unmounted) before the dispatcher returned.
        // Abort the stranded session and skip the state mutations — the
        // current email's panel must not flip to streaming on a sessionId
        // it didn't subscribe to.
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
    setStreamingMessageId(null)
    setError(null)
    setLastFailedInput(null)
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
  }, [mailApi])

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
      const result = await mailApi.chat.editMessage({
        sessionId: activeSessionId,
        editingMessageId: input.messageId,
        newContent: input.newContent,
        backendKind: input.backendKind,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: input.backendAgentPageId ?? null,
        // task 06-08-chat 需求 5 — per-turn thinking toggle for the re-stream.
        thinking: input.thinking
      })
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
        setStreamingMessageId(null)
        setLastFailedInput(null)
        setError(null)
        // task 06-08-chat PR B — the active session is being deleted; clear its
        // live tool steps along with the rest of the renderer state.
        setLiveToolCalls(new Map())
      }
      mailApi.chat.deleteSession(sessionId)
      setSessions((cur) => cur.filter((s) => s.id !== sessionId))
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
    sessions,
    selectSession,
    editMessage,
    deleteSession,
    pendingConfirmations,
    confirmTool,
    liveToolCalls
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
// anti-automation ban. It routes through the quota cooldown instead (see the
// error-event handler above), which disables send + shows a countdown rather
// than a Retry button.
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
