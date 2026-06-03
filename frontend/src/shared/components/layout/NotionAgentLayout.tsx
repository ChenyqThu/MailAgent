// /notion-agent route shell — Notion Agent 区。参考 Custom AI（/agents）的结构，
// 但 Notion Agent 暂无可配置 agents / 报告，故仅保留一个 Chats（notion-agent
// scoped 的会话历史 + transcript 预览）。未来要加 Notion Agent 的 agents/报告时，
// 这里可升级成与 AgentsPage 同款的多 tab 壳。
import { PageFrame } from './PageFrame'
import { ChatsTab } from '../agents/ChatsTab'

export function NotionAgentLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="notion-agent" mainClassName="flex flex-col overflow-hidden min-w-0">
      <ChatsTab backend="notion-agent" />
    </PageFrame>
  )
}
