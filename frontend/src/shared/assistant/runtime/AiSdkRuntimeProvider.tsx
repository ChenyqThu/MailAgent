// chat-panel P4 Phase 02 — AI SDK runtime provider.
//
// Phase 02 — builds the AI SDK
// `useChatRuntime` (pointed at the embedded Gateway) and mounts
// AssistantRuntimeProvider so the same Thread / Message / Composer primitives
// render against it. Kept a separate component (not a branch inside
// MailAgentRuntimeProvider) so each provider calls exactly ONE runtime hook
// unconditionally — no rules-of-hooks violation, and @assistant-ui/react-ai-sdk
// only loads when this component is actually rendered (the AI SDK opt-in path).

import { AssistantRuntimeProvider } from '@assistant-ui/react'

import {
  useMailAgentAiSdkRuntime,
  type UseMailAgentAiSdkRuntimeOptions
} from './useMailAgentAiSdkRuntime'

type AiSdkRuntimeProviderProps = UseMailAgentAiSdkRuntimeOptions & {
  children: React.ReactNode
}

export function AiSdkRuntimeProvider({
  children,
  ...options
}: AiSdkRuntimeProviderProps): React.JSX.Element {
  const runtime = useMailAgentAiSdkRuntime(options)
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
