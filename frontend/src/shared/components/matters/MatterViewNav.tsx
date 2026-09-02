// 事项二级栏顶部的视图行。
//
// 一行装下事项域的三个入口：左侧两个视图钮（今日看板 / 事项），右端「新建」CTA。整条住在
// 清单列（默认 336，读 --app-second-w）顶部，不是横跨内容区的通栏 tab 栏 —— 与「二级栏按域记忆宽 / 折叠」的
// 框架语言一致。
//
// 样式全部跟随既有先例，不新造语言：
//  · 视图钮 = `DomainPanel::NavRow` / `TodayNavPanel` 的 30px 导航行几何；单行排布下
//    宽度按内容走，不通栏。选中态取 `.tab-active`（底部 accent 指示条）而不是导航行的
//    `row-selected acc-select`（左条 + wash）—— 见 renderView 处的注释；
//  · 「新建」= `.list-cta`（收件箱「写邮件」CTA 的同一配色层），实心 accent 与左侧两个
//    视图钮区分出「动作」而非「视图」。它仍是唯一常驻创建入口（无 ⌘N、无第二条路径）。
//    可视文案压短成「新建」是为了单行放得下，无障碍名与 title 仍是完整的「新建事项」。
//
// 宽度预算（放不下时才该改形态）：容器 336 − px-1.5×2 = 324，中文占约 257、英文约 292。
// 未来加「board 看板」等视图 = 行内多写一个钮；不预建视图注册表，不写响应式换行。

import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { cn } from '@shared/lib/cn'

import { MATTER_TAB_ICONS, type MatterTab } from './matterListQuery'

interface MatterViewNavProps {
  tab: MatterTab
  /** 今日看板行的角标 = 开放关注信号数 + 待审阅提案数（口径在 MattersWorkspace）。 */
  boardBadge: number
  onSelectTab(tab: MatterTab): void
  onCreate(): void
}

/** 30px 导航行的公共几何（DomainPanel::NavRow 同款，单行排布下宽度按内容走）。 */
const ROW_CLASS =
  'row relative flex h-[30px] items-center gap-2 rounded-[var(--r-ctl)] px-2 ' +
  'text-left text-body transition-colors duration-fast'

export function MatterViewNav({
  tab,
  boardBadge,
  onSelectTab,
  onCreate
}: MatterViewNavProps): React.ReactElement {
  const { t } = useTranslation()

  /** 一个视图钮。 */
  const renderView = (value: MatterTab, badge = 0): React.ReactElement => {
    const Icon = MATTER_TAB_ICONS[value]
    const selected = tab === value
    return (
      <button
        type="button"
        onClick={() => onSelectTab(value)}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          ROW_CLASS,
          'min-w-0',
          // 选中态 = 底部 accent 指示条（.tab-active 先例，owner 0828：单行水平排布
          // 下高亮条放底部，不用导航行的左条 + wash）。
          selected
            ? 'tab-active font-medium'
            : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
        )}
      >
        <Icon size={14} className="shrink-0" />
        <span className="truncate">{t(`matters.moduleTabs.${value}`)}</span>
        {badge > 0 ? (
          <span className="min-w-[15px] shrink-0 rounded-full bg-crit px-1 text-center font-mono text-[10.5px] font-semibold leading-[15px] text-white">
            {badge}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <nav
      aria-label={t('matters.nav')}
      // 底色与下方 `MatterList` 的 section 同档（同一列，两段各铺一层，见 MattersWorkspace
      // 里列容器不铺底色的注释）。
      className="flex shrink-0 items-center gap-1 border-b border-ink-border bg-ink-1/55 px-1.5 py-1.5"
      data-matter-view-nav
    >
      {renderView('board', boardBadge)}
      {renderView('list')}
      <button
        type="button"
        onClick={onCreate}
        aria-label={t('matters.create.title')}
        title={t('matters.create.title')}
        className={cn(ROW_CLASS, 'list-cta ml-auto shrink-0 font-medium')}
      >
        <Plus size={14} className="shrink-0" />
        <span>{t('matters.create.short')}</span>
      </button>
    </nav>
  )
}
