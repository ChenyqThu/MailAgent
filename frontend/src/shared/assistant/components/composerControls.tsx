// chat-panel P4 composer-parity — controls context.
//
// Bridges PANEL-owned chat state (extended-thinking toggle / model picker, and —
// C2 — @mention / attachments) into the assistant-ui ThreadComposer, which renders
// INSIDE the runtime provider (below the panel) where it can't reach panel state by
// prop. The panel computes a ChatComposerControls value and wraps the thread in the
// provider; ThreadComposer reads it via useChatComposerControls().
//
// 🔴 Back-compat / flag discipline: useChatComposerControls() returns null when no
//    provider is mounted, and ThreadComposer renders its bare Phase-01 text-only form
//    in that case. So a render path that does NOT supply controls (older tests, the
//    read-only notion-agent thread) is byte-identical to the pre-parity composer.


import { ChatComposerControlsContext, type ChatComposerControls } from './composerControlsContext'

// 🔴 不在这里 re-export hook/类型：re-export 非组件同样触发 only-export-components，
// 本文件必须只导出 Provider。消费方直接从 './composerControlsContext' 取。

export function ChatComposerControlsProvider({
  value,
  children
}: {
  value: ChatComposerControls
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <ChatComposerControlsContext.Provider value={value}>
      {children}
    </ChatComposerControlsContext.Provider>
  )
}
