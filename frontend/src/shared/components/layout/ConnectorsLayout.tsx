// /connectors route shell — Connectors 独立配置台（08-06）。同其它次级路由的 chrome：
// TitleBar + Sidebar + StatusBar via PageFrame。页面自管左右两栏 + 各自滚动，故给它
// column-flex main 槽（无外层滚动，AgentsLayout 同款）。
import { PageFrame } from './PageFrame'
import { ConnectorsConsolePage } from '../connectors/ConnectorsConsolePage'

export function ConnectorsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="connectors" mainClassName="flex-1 flex flex-col overflow-hidden min-w-0">
      <ConnectorsConsolePage />
    </PageFrame>
  )
}
