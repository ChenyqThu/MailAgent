// /reports route shell — 报告域（08-27 P3 从 `/agents?tab=reports` 拆出）。
//
// 报告域是 'page' 档：二级栏就是 ReportsPage 自己的清单列（宽读 `--app-second-w`），所以 <main>
// 不自建滚动（清单与详情各自滚），整条高度交给页面 —— 同 ContactsLayout。
import { PageFrame } from './PageFrame'
import { ReportsPage } from '../agents/ReportsPage'

export function ReportsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="reports" mainClassName="flex-1 min-w-0 overflow-hidden">
      <ReportsPage />
    </PageFrame>
  )
}
