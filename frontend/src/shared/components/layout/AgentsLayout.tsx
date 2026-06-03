// /agents route shell — Custom AI Agents 区（Agents / 报告 / Chats）。同其它
// 次级路由（admin / llm / calendar / sessions）的 chrome：TitleBar + Sidebar +
// StatusBar via PageFrame。AgentsPage 自管 tab 栏 + 各 tab 内部滚动，故给它
// column-flex main 槽（无外层滚动）。
import { PageFrame } from './PageFrame'
import { AgentsPage } from '../agents/AgentsPage'

export function AgentsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="agents" mainClassName="flex-1 flex flex-col overflow-hidden min-w-0">
      <AgentsPage />
    </PageFrame>
  )
}
