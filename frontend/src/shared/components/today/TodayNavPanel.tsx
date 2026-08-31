// 「今日」域的二级栏 —— 当天五节跳转（task 08-27-l4-tab-workspace P1，P4c 补计数与 meta）。
//
// 形态抄原型 Main.dc.html 的 todayNav 段：两组段头（需要你 / 接下来）+ 五行
// （等你拍板 / 今天的会 / 待回邮件 / 临期事项 / 智能体产出）。点行 = 写
// useTodaySection + 落回 /today，主区滚到那一节。
//
// 🔴 **计数与主区同源**：`useTodaySections()` 的 `TodaySectionView.count` 就是主区那一节
// 屏幕上的行数，两处读同一个字段。这里自己数一遍必然漂开（一处算了过滤、一处没算）。
// P1 那版之所以不带计数，正是因为「不从批次 2 例外面的分组模型硬凑一份口径不一的数字」。
//
// meta（第二行）只在算得出一句有信息量的节上出现（下一场几点 / 最久那封等了多久），
// 算不出的节就只有标题 + 计数 —— 不用「N 件待处理」把右边的计数换个说法再写一遍。

import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'
import {
  TODAY_SECTION_GROUPS,
  useTodaySection,
  type TodaySectionId
} from '@shared/state/today-section'

import { useTodaySections } from './useTodaySections'

export function TodayNavPanel(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const section = useTodaySection((s) => s.section)
  const setSection = useTodaySection((s) => s.setSection)
  const { byId } = useTodaySections()

  // 落点走 registry（path 字面量不出 registry）。
  const todayEntry = navEntry('today')

  const handleClick = (id: TodaySectionId): void => {
    setSection(id)
    // 面板只在 today 域显示，但收起/展开的竞态下路由可能已离开 —— 落回今日兜底。
    if (pathname !== todayEntry.to) navigateToNavEntry(navigate, todayEntry)
  }

  const renderRow = (id: TodaySectionId): React.ReactElement => {
    const selected = section === id
    const view = byId[id]
    const hasMeta = view.meta.length > 0
    return (
      <button
        key={id}
        type="button"
        data-today-nav-row={id}
        onClick={() => handleClick(id)}
        className={cn(
          'row relative w-full flex items-center gap-2 px-2 rounded-[var(--r-ctl)]',
          hasMeta ? 'py-1' : 'h-[30px]',
          'text-body text-left transition-colors duration-fast',
          selected
            ? 'row-selected acc-select text-ink-fg font-medium'
            : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{t(`today.nav.${id}`)}</span>
          {hasMeta && (
            <span className="truncate text-micro font-normal text-ink-fg-3">{view.meta}</span>
          )}
        </span>
        {/* 0 不显示 —— 一列 0 只是噪音，那一节主区里也不会出现。 */}
        {view.count > 0 && (
          <span data-today-nav-count={id} className="shrink-0 font-mono text-micro text-ink-fg-3">
            {view.count}
          </span>
        )}
      </button>
    )
  }

  return (
    <nav
      className="flex-1 overflow-y-auto scrollbar-thin px-1.5 pb-2 space-y-px"
      data-today-nav
      aria-label={t('nav.today')}
    >
      {TODAY_SECTION_GROUPS.map((group) => (
        <div key={group.labelKey}>
          <h2 className="nav-panel-sechdr text-micro font-mono uppercase">{t(group.labelKey)}</h2>
          {group.sections.map(renderRow)}
        </div>
      ))}
    </nav>
  )
}
