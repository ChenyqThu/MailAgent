// S3 W2 (D6) — read-only transcript of a persisted chat session.
//
// The unified rendering path for history that can no longer run a live turn:
// legacy backend_kind rows ('custom-api' / retired 'notion-agent') after the
// legacy runtime was deleted, plus any caller that just wants a transcript
// preview (ChatsTab). Rows WITH ui_message_json render their full AI SDK parts
// (reasoning / tool traces); legacy rows without it degrade to plain text via
// chatMessageToUIMessage's content fallback — tolerant by design, no legacy
// components involved.
//
// Implementation: the SAME AiSdkRuntimeProvider the live path uses, seeded with
// initialMessages and rendered with a readOnly AssistantThread (no composer →
// the transport never fires, so the gateway base URL is irrelevant; '' is fine
// when no gateway port was discovered).
//
// 🔴 Mount contract: `messages` must be LOADED before mounting (initialMessages
// only seeds useChatRuntime at mount). Key on the session id (`sessionKey`) so
// switching sessions remounts with the new transcript.

import { useMemo } from 'react'

import type { ChatMessage } from '@shared/api/types'

import { AiSdkRuntimeProvider } from './runtime/AiSdkRuntimeProvider'
import { resolveAiGatewayBaseUrl } from './runtime/flags'
import { AssistantThread } from './components/thread'
import { chatMessageToUIMessage } from './uiMessage'

export interface ReadOnlyTranscriptProps {
  /** Persisted rows of the session, oldest-first (already loaded). */
  messages: ReadonlyArray<ChatMessage>
  /** Remount key — the session id (a switch must re-seed the runtime). */
  sessionKey: string | number
  /** Rendered when `messages` is empty. */
  emptyState?: React.ReactNode
}

export function ReadOnlyTranscript({
  messages,
  sessionKey,
  emptyState
}: ReadOnlyTranscriptProps): React.JSX.Element {
  const initialMessages = useMemo(() => messages.map(chatMessageToUIMessage), [messages])
  // Read-only: no send → no POST; fall back to '' when no gateway port is
  // discoverable so the transcript still renders while the gateway is down.
  const gatewayBaseUrl = useMemo(() => resolveAiGatewayBaseUrl() ?? '', [])
  return (
    <AiSdkRuntimeProvider
      key={sessionKey}
      gatewayBaseUrl={gatewayBaseUrl}
      sessionId={null}
      initialMessages={initialMessages}
    >
      <AssistantThread readOnly emptyState={emptyState} />
    </AiSdkRuntimeProvider>
  )
}
