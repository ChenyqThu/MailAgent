// chat-panel P4 Phase 02 — AI SDK runtime provider.
//
// Phase 02 — builds the AI SDK
// `useChatRuntime` (pointed at the embedded Gateway) and mounts
// AssistantRuntimeProvider so the same Thread / Message / Composer primitives
// render against it. Kept a separate component (not a branch inside
// MailAgentRuntimeProvider) so each provider calls exactly ONE runtime hook
// unconditionally — no rules-of-hooks violation, and @assistant-ui/react-ai-sdk
// only loads when this component is actually rendered (the AI SDK opt-in path).

import { useEffect, useSyncExternalStore } from 'react'
import { AssistantRuntimeProvider, useAui } from '@assistant-ui/react'

import {
  useMailAgentAiSdkRuntime,
  type UseMailAgentAiSdkRuntimeOptions
} from './useMailAgentAiSdkRuntime'
import {
  clearComposerRecovery,
  getComposerRecovery,
  subscribeComposerRecovery
} from './composerRecovery'

type AiSdkRuntimeProviderProps = UseMailAgentAiSdkRuntimeOptions & {
  children: React.ReactNode
}

/** 0903 —— 「这一句话没送出去」的交还端。住在 provider **里面**（composer 只有这里拿得到），
 *  纯副作用、渲染 null。发布端是 transport 的 fetch 包装（见 composerRecovery.ts 的头注）。 */
function ComposerRecoveryBridge({ sessionId }: { sessionId: number | null }): null {
  const aui = useAui()
  const recovery = useSyncExternalStore(
    (listener) => (sessionId == null ? () => {} : subscribeComposerRecovery(sessionId, listener)),
    () => (sessionId == null ? null : getComposerRecovery(sessionId))
  )
  useEffect(() => {
    if (sessionId == null || recovery == null) return
    aui.composer().setText(recovery.text)
    clearComposerRecovery(sessionId, recovery.nonce)
  }, [aui, recovery, sessionId])
  return null
}

export function AiSdkRuntimeProvider({
  children,
  ...options
}: AiSdkRuntimeProviderProps): React.JSX.Element {
  const runtime = useMailAgentAiSdkRuntime(options)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerRecoveryBridge sessionId={options.sessionId ?? null} />
      {children}
    </AssistantRuntimeProvider>
  )
}
