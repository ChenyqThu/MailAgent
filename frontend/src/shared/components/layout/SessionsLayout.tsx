// /sessions route shell — 全局「AI 会话历史」。Sprint 20 起改用统一的双栏
// ChatsTab（不传 backend = 全部会话 + backend 筛选分类 + transcript 预览），与
// Custom AI / Notion Agent 的 per-agent chats 同组件、同体验。旧单栏 SessionsPage
// 已退役（仅文件保留，无引用）。

import { PageFrame } from './PageFrame'
import { ChatsTab } from '../agents/ChatsTab'

export function SessionsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="ai-sessions" mainClassName="flex flex-col overflow-hidden min-w-0">
      <ChatsTab />
    </PageFrame>
  )
}
