// /sessions route shell — 对话域：MailAgent 交互式通用 agent 视图（左历史 + 实时对话 +
// 快捷操作）。08-27 P3：`/agents` 的 chats tab 腿拆掉后，本路由是对话域的唯一承载。

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
