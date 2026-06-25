// chat-panel P4 Phase 05 — AG-UI event vocabulary (interop mirror).
//
// AG-UI (https://docs.ag-ui.com) is the standard agent-event protocol the mirror endpoint
// (/api/ai/agui/chat) speaks so external agent clients / CopilotKit / future protocol consumers
// can drive a MailAgent run. This module is the FAITHFUL, DEPENDENCY-FREE TypeScript shape of the
// AG-UI core event union we emit — the field names mirror the @ag-ui/core `EventType` + event
// schemas exactly, but we deliberately do NOT depend on the `@ag-ui/*` npm packages:
//   - the mirror is a flag-off旁路 (MAILAGENT_AG_UI_MIRROR, default off); pulling a runtime dep
//     into the always-loaded gateway bundle for an off-by-default feature is the wrong trade;
//   - keeping it a plain union makes the eventMapper golden-snapshot tests pure-Node and the
//     whole adapter harness-testable without an AG-UI client (phase-05 §10 fallback acceptance).
// If the assistant-ui AG-UI runtime adapter is later adopted, these shapes already line up with
// @ag-ui/core, so the wire bytes are interoperable.
//
// 🔴 Pure types + constructors only (no node:* / electron / ai imports) — safe everywhere.
// 🔴 No `timestamp` on the canonical events: the AG-UI BaseEvent.timestamp is optional, and
//    omitting it keeps the eventMapper golden snapshots deterministic (no clock in the bytes).

/** The AG-UI core event types the mirror emits. Values are the canonical AG-UI `EventType`
 *  string constants (SCREAMING_SNAKE_CASE) so a real AG-UI client parses them unchanged. */
export const AgUiEventType = {
  RunStarted: 'RUN_STARTED',
  RunFinished: 'RUN_FINISHED',
  RunError: 'RUN_ERROR',
  StepStarted: 'STEP_STARTED',
  StepFinished: 'STEP_FINISHED',
  TextMessageStart: 'TEXT_MESSAGE_START',
  TextMessageContent: 'TEXT_MESSAGE_CONTENT',
  TextMessageEnd: 'TEXT_MESSAGE_END',
  ThinkingStart: 'THINKING_START',
  ThinkingEnd: 'THINKING_END',
  ThinkingTextMessageStart: 'THINKING_TEXT_MESSAGE_START',
  ThinkingTextMessageContent: 'THINKING_TEXT_MESSAGE_CONTENT',
  ThinkingTextMessageEnd: 'THINKING_TEXT_MESSAGE_END',
  ToolCallStart: 'TOOL_CALL_START',
  ToolCallArgs: 'TOOL_CALL_ARGS',
  ToolCallEnd: 'TOOL_CALL_END',
  ToolCallResult: 'TOOL_CALL_RESULT',
  StateSnapshot: 'STATE_SNAPSHOT',
  Custom: 'CUSTOM'
} as const

export type AgUiEventTypeValue = (typeof AgUiEventType)[keyof typeof AgUiEventType]

// ── run lifecycle ───────────────────────────────────────────────────────────────────────────

/** The terminal outcome of a run. `'success'` = the model finished; `'requires_action'` = the run
 *  paused on a tool-approval interrupt (the client must respond before it can resume). */
export type AgUiRunResult =
  | { status: 'success'; finishReason?: string }
  | { status: 'requires_action'; interrupt: AgUiInterruptValue }

export interface AgUiRunStartedEvent {
  type: typeof AgUiEventType.RunStarted
  threadId: string
  runId: string
}

export interface AgUiRunFinishedEvent {
  type: typeof AgUiEventType.RunFinished
  threadId: string
  runId: string
  result?: AgUiRunResult
}

export interface AgUiRunErrorEvent {
  type: typeof AgUiEventType.RunError
  message: string
  code?: string
}

export interface AgUiStepStartedEvent {
  type: typeof AgUiEventType.StepStarted
  stepName: string
}

export interface AgUiStepFinishedEvent {
  type: typeof AgUiEventType.StepFinished
  stepName: string
}

// ── assistant text ──────────────────────────────────────────────────────────────────────────

export interface AgUiTextMessageStartEvent {
  type: typeof AgUiEventType.TextMessageStart
  messageId: string
  role: 'assistant'
}

export interface AgUiTextMessageContentEvent {
  type: typeof AgUiEventType.TextMessageContent
  messageId: string
  delta: string
}

export interface AgUiTextMessageEndEvent {
  type: typeof AgUiEventType.TextMessageEnd
  messageId: string
}

// ── thinking / reasoning ────────────────────────────────────────────────────────────────────

export interface AgUiThinkingStartEvent {
  type: typeof AgUiEventType.ThinkingStart
  title?: string
}

export interface AgUiThinkingEndEvent {
  type: typeof AgUiEventType.ThinkingEnd
}

export interface AgUiThinkingTextMessageStartEvent {
  type: typeof AgUiEventType.ThinkingTextMessageStart
  messageId: string
}

export interface AgUiThinkingTextMessageContentEvent {
  type: typeof AgUiEventType.ThinkingTextMessageContent
  messageId: string
  delta: string
}

export interface AgUiThinkingTextMessageEndEvent {
  type: typeof AgUiEventType.ThinkingTextMessageEnd
  messageId: string
}

// ── tool calls ──────────────────────────────────────────────────────────────────────────────

export interface AgUiToolCallStartEvent {
  type: typeof AgUiEventType.ToolCallStart
  toolCallId: string
  toolCallName: string
  parentMessageId?: string
}

export interface AgUiToolCallArgsEvent {
  type: typeof AgUiEventType.ToolCallArgs
  toolCallId: string
  delta: string
}

export interface AgUiToolCallEndEvent {
  type: typeof AgUiEventType.ToolCallEnd
  toolCallId: string
}

export interface AgUiToolCallResultEvent {
  type: typeof AgUiEventType.ToolCallResult
  messageId: string
  toolCallId: string
  content: string
  role: 'tool'
}

// ── state + custom ──────────────────────────────────────────────────────────────────────────

export interface AgUiStateSnapshotEvent<S = unknown> {
  type: typeof AgUiEventType.StateSnapshot
  snapshot: S
}

/** The MailAgent approval interrupt carried by a CUSTOM event (AG-UI's extension point) and as the
 *  `requires_action` run result. Shape per phase-05 §7 — NO token / provider key (interruptMapper
 *  builds it from the approval record + tool input only). */
export interface AgUiInterruptValue {
  id: string
  name: string
  payload: {
    toolCallId: string
    input: unknown
    risk: 'preview' | 'edit' | 'blocking'
    reason: string
    expiresAt: string
    a2ui?: unknown
  }
}

/** A generic AG-UI CUSTOM event (named extension). The mirror uses it to carry the approval
 *  interrupt (`name: 'Interrupt'`), which the core enum has no first-class event for. */
export interface AgUiCustomEvent<V = unknown> {
  type: typeof AgUiEventType.Custom
  name: string
  value: V
}

/** The discriminated union of every AG-UI event the mirror can emit. */
export type AgUiEvent =
  | AgUiRunStartedEvent
  | AgUiRunFinishedEvent
  | AgUiRunErrorEvent
  | AgUiStepStartedEvent
  | AgUiStepFinishedEvent
  | AgUiTextMessageStartEvent
  | AgUiTextMessageContentEvent
  | AgUiTextMessageEndEvent
  | AgUiThinkingStartEvent
  | AgUiThinkingEndEvent
  | AgUiThinkingTextMessageStartEvent
  | AgUiThinkingTextMessageContentEvent
  | AgUiThinkingTextMessageEndEvent
  | AgUiToolCallStartEvent
  | AgUiToolCallArgsEvent
  | AgUiToolCallEndEvent
  | AgUiToolCallResultEvent
  | AgUiStateSnapshotEvent
  | AgUiCustomEvent

/** The CUSTOM event name the mirror uses for a tool-approval interrupt. */
export const AG_UI_INTERRUPT_CUSTOM_NAME = 'Interrupt' as const
