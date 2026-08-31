import { useTranslation } from 'react-i18next'

import { PageFrame } from '@shared/components/layout/PageFrame'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'
import { useTodaySection } from '@shared/state/today-section'

import { TodaySurface } from './TodaySurface'

/** `/today` 路由的内容壳。二级栏是域面板里的五节跳转（`TodayNavPanel`），
 *  `<main>` 独占中间内容区、自管滚动（PageFrame 默认）。 */
export function TodayLayout(): React.ReactElement {
  const { t } = useTranslation()
  // 主标签第二段 = 二级栏选中的那一节（design §三）。词表与 TodayNavPanel 同源
  // （`today.nav.*`），P4c 重做五节主区后仍是这一份。
  const section = useTodaySection((s) => s.section)
  useMainBreadcrumb('today', t(`today.nav.${section}`))

  return (
    <PageFrame ariaLabel="today">
      <TodaySurface />
    </PageFrame>
  )
}
