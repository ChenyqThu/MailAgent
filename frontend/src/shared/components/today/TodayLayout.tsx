import { PageFrame } from '@shared/components/layout/PageFrame'
import { TodayExceptionSurface } from './TodayExceptionSurface'

/** `/today` 路由的内容壳。域二级栏形态是 `'none'`（同日历，见 `NAV_DOMAINS.today`），
 *  所以这一屏没有面板列，`<main>` 独占中间内容区、自管滚动（PageFrame 默认）。 */
export function TodayLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="today">
      <TodayExceptionSurface />
    </PageFrame>
  )
}
