// 事项二级栏顶部的视图折叠组（08-27 dogfood 修正批·波 2）。
//
// owner 装机反馈：「事项 / 看板不应该是通栏，新建事项一起，放在二级折叠菜单里」。
// 原来那条 42px 通栏模块 tab 栏（tablist + 右端「新建事项」主按钮）横跨整个内容区，
// 与「左列定宽 392、切域边界不动」的框架语言打架；现在它整条收进清单列（336）顶部。
//
// 样式全部跟随既有先例，不新造语言：
//  · 组头 = `.nav-panel-sechdr`（TodayNavPanel / FolderMenu 的段头，mono uppercase），
//    加上 `MatterList::MatterGroupHead` 那套 chevron 交互（ChevronRight/Down 11px +
//    aria-expanded + 整条可点 + 同一句 title 文案）；
//  · 视图行 = `DomainPanel::NavRow` / `TodayNavPanel` 的 30px 导航行（选中态
//    `row-selected acc-select`）；
//  · 「新建事项」= `.list-cta`（收件箱「写邮件」CTA 的同一配色层），实心 accent 与上面
//    两行区分出「动作」而非「视图」。它仍是唯一常驻创建入口（无 ⌘N、无第二条路径）。
//
// 折叠态跟随所参照的分组先例（MatterList 行内分组）：住 `matterWorkspaceStore` 的
// 模块级 store，会话级、不持久化。

import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'

import { cn } from '@shared/lib/cn'

import { MATTER_TAB_ICONS, type MatterTab } from './matterListQuery'
import { useMatterWorkspace } from './matterWorkspaceStore'

interface MatterViewNavProps {
  tab: MatterTab
  /** 今日看板行的角标 = 开放关注信号数 + 待审阅提案数（口径在 MattersWorkspace）。 */
  boardBadge: number
  onSelectTab(tab: MatterTab): void
  onCreate(): void
}

/** 30px 导航行的公共几何（DomainPanel::NavRow 同款）。 */
const ROW_CLASS =
  'row relative flex h-[30px] w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 ' +
  'text-left text-body transition-colors duration-fast'

export function MatterViewNav({
  tab,
  boardBadge,
  onSelectTab,
  onCreate
}: MatterViewNavProps): React.ReactElement {
  const { t } = useTranslation()
  const collapsed = useMatterWorkspace((state) => state.viewNavCollapsed)
  const toggleViewNav = useMatterWorkspace((state) => state.toggleViewNav)
  const Chevron = collapsed ? ChevronRight : ChevronDown

  /** 一条视图行。未来加「board 看板」等视图 = 在下面多写一行，不预建视图注册表。 */
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
          selected
            ? 'row-selected acc-select font-medium text-ink-fg'
            : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
        )}
      >
        <Icon size={14} className="shrink-0" />
        <span className="flex-1 truncate">{t(`matters.moduleTabs.${value}`)}</span>
        {badge > 0 ? (
          <span className="min-w-[15px] shrink-0 rounded-full bg-crit px-1 text-center font-mono text-[10.5px] font-semibold leading-[15px] text-white">
            {badge}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <div
      // 底色与下方 `MatterList` 的 section 同档（同一列，两段各铺一层，见 MattersWorkspace
      // 里列容器不铺底色的注释）。
      className="shrink-0 border-b border-ink-border bg-ink-1/55 px-1.5 pb-2"
      data-matter-view-nav
    >
      <button
        type="button"
        onClick={toggleViewNav}
        aria-expanded={!collapsed}
        title={t('matters.groupHead.toggle')}
        className="nav-panel-sechdr flex w-full items-center gap-1 text-micro font-mono uppercase transition-colors duration-fast hover:text-ink-fg-2"
      >
        <Chevron size={11} className="shrink-0" />
        <span className="truncate">{t('nav.section.view')}</span>
      </button>
      {collapsed ? null : (
        <nav aria-label={t('matters.nav')} className="space-y-px">
          {renderView('board', boardBadge)}
          {renderView('list')}
          <button
            type="button"
            onClick={onCreate}
            className={cn(ROW_CLASS, 'list-cta mt-1 font-medium')}
          >
            <Plus size={14} className="shrink-0" />
            <span className="flex-1 truncate">{t('matters.create.submit')}</span>
          </button>
        </nav>
      )}
    </div>
  )
}
