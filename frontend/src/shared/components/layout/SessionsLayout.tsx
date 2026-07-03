// /sessions route shell — MailAgent 交互式通用 agent 视图（左历史 + 实时对话 +
// 快捷操作）。S3 W2：flag-off 的只读 ChatsTab 分支随 legacy UI 收敛移除（ChatsTab
// 本体保留，仍服务 /agents?tab=chats 的 per-agent 只读浏览）。

import { lazy, Suspense } from 'react'

import { PageFrame } from './PageFrame'

// Lazy so the agent view's heavy deps (assistant-ui lexical composer + lexical) ride their own chunk.
const AgentViewLayout = lazy(() =>
  import('../agents/AgentViewLayout').then((m) => ({ default: m.AgentViewLayout }))
)

export function SessionsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="mail-agent" mainClassName="flex-1 flex flex-col overflow-hidden min-w-0">
      <Suspense fallback={<div className="flex-1" />}>
        <AgentViewLayout />
      </Suspense>
    </PageFrame>
  )
}
