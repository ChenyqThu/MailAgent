// /sessions route shell — 「AI 会话历史」。
//
// flag-off（默认）：统一的双栏只读 ChatsTab（不传 backend = 全部会话 + backend 筛选 + transcript
//   预览），与 Custom AI 的 per-agent chats 同组件。旧单栏 SessionsPage 已退役（仅文件保留）。
// flag-on（MAILAGENT_AGENT_VIEW）：交互式 MailAgent 通用 agent 视图（左历史 + 实时对话 + 快捷操作）。
//   redesign —— 把这个只读浏览面改造成通用 agent 入口；同路由原地换组件，flag-off 字节级不变。

import { lazy, Suspense } from 'react'

import { isAgentViewEnabled } from '@shared/assistant/runtime/flags'

import { PageFrame } from './PageFrame'
import { ChatsTab } from '../agents/ChatsTab'

// Lazy so the agent view's heavy deps (assistant-ui lexical composer + lexical) ride a flag-on-only
// chunk — flag-off (ChatsTab) never loads them.
const AgentViewLayout = lazy(() =>
  import('../agents/AgentViewLayout').then((m) => ({ default: m.AgentViewLayout }))
)

export function SessionsLayout(): React.ReactElement {
  if (isAgentViewEnabled()) {
    return (
      <PageFrame
        ariaLabel="mail-agent"
        mainClassName="flex-1 flex flex-col overflow-hidden min-w-0"
      >
        <Suspense fallback={<div className="flex-1" />}>
          <AgentViewLayout />
        </Suspense>
      </PageFrame>
    )
  }
  return (
    <PageFrame ariaLabel="ai-sessions" mainClassName="flex-1 flex flex-col overflow-hidden min-w-0">
      <ChatsTab />
    </PageFrame>
  )
}
