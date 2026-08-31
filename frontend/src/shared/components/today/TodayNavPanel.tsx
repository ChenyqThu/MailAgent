// 「今日」域的二级栏 —— 当天五节跳转（task 08-27-l4-tab-workspace P1）。
//
// 形态抄原型 Main.dc.html 的 todayNav 段：两组段头（需要你 / 接下来）+ 五行
// （等你拍板 / 今天的会 / 待回邮件 / 临期事项 / 智能体产出）。点行 = 写
// useTodaySection + 落回 /today，主区滚动/高亮到最接近的现有分组。
//
// P1 过渡：行只有标题，不带 meta 与计数 —— 那两样要 P4 的「今日聚合端点」
// （五节 + 每条「为什么是今天」+ 下一个硬时间点一次算出）才有真实数据，这里
// 不从批次 2 例外面的分组模型硬凑一份口径不一的数字。

import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'
import {
  TODAY_SECTION_GROUPS,
  useTodaySection,
  type TodaySectionId
} from '@shared/state/today-section'

export function TodayNavPanel(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const section = useTodaySection((s) => s.section)
  const setSection = useTodaySection((s) => s.setSection)

  // 落点走 registry（path 字面量不出 registry）。
  const todayEntry = navEntry('today')

  const handleClick = (id: TodaySectionId): void => {
    setSection(id)
    // 面板只在 today 域显示，但收起/展开的竞态下路由可能已离开 —— 落回今日兜底。
    if (pathname !== todayEntry.to) navigateToNavEntry(navigate, todayEntry)
  }

  const renderRow = (id: TodaySectionId): React.ReactElement => {
    const selected = section === id
    return (
      <button
        key={id}
        type="button"
        onClick={() => handleClick(id)}
        className={cn(
          'row relative w-full flex items-center gap-2 h-[30px] px-2 rounded-[var(--r-ctl)]',
          'text-body text-left transition-colors duration-fast',
          selected
            ? 'row-selected acc-select text-ink-fg font-medium'
            : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
        )}
      >
        <span className="flex-1 truncate">{t(`today.nav.${id}`)}</span>
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
