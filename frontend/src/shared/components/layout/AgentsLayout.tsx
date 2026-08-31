// /agents route shell — 团队域。08-27 P4a：卡片网格（AgentsTab）退役，改为
// 「清单（页面自管二级栏 336）+ 成员详情（对话/执行 ｜ 设置 两档）」的 TeamWorkspace。
// TeamWorkspace 自管内部滚动，故给它 column-flex main 槽（无外层滚动）。
import { PageFrame } from './PageFrame'
import { TeamWorkspace } from '../agents/team/TeamWorkspace'

export function AgentsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="agents" mainClassName="flex-1 flex flex-col overflow-hidden min-w-0">
      <TeamWorkspace />
    </PageFrame>
  )
}
