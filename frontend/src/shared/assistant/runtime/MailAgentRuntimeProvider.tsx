// chat-panel P4 Phase 01 — assistant-ui runtime provider.
//
// Thin wrapper: builds the legacy ExternalStore runtime from the supplied chat
// slice + action callbacks, then mounts AssistantRuntimeProvider so the Thread /
// Message / Composer primitives underneath can read it. Tool UIs are wired at
// the part level (MessagePrimitive.Parts components in message.tsx) — Phase 01
// ships only the generic ToolTraceCard fallback, so there is nothing to register
// imperatively here (per-tool makeAssistantToolUI cards land in phase-04).

import { AssistantRuntimeProvider } from '@assistant-ui/react'

import {
  useLegacyExternalStoreRuntime,
  type UseLegacyExternalStoreRuntimeOptions
} from './useLegacyExternalStoreRuntime'

type MailAgentRuntimeProviderProps = UseLegacyExternalStoreRuntimeOptions & {
  children: React.ReactNode
}

export function MailAgentRuntimeProvider({
  children,
  ...options
}: MailAgentRuntimeProviderProps): React.JSX.Element {
  const runtime = useLegacyExternalStoreRuntime(options)
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
