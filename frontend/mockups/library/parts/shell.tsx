// App 外壳的仿制：56px 图标导轨 + 二级栏 + 内容区 + 右侧 dock。
//
// 🔴 这是**仿制**不是复用：真 Sidebar / IconRail / NavPeek 依赖 registry + zustand +
// TanStack router，拉进 mockup 等于把半个 app 拉进来。这里只借它们的 authored CSS
// 类（`.nav-rail` / `.nav-rail-cell` / `.railbtn` / `.raillabel` / `.railbadge` /
// `.nav-panel` / `.nav-peek`，全在 src/electron/renderer/index.css），所以几何、
// 选中态、hover 明度与真 app 逐像素一致。
//
// 落地时这一层整个丢掉：资料库域只要按 design §2.1 往 registry 加一条 entry
// （rail order 9 / palette 35 / icon FolderTreeIcon / second:'page'），外壳白拿。

import * as React from 'react'
import {
  BarChart3,
  CalendarDays,
  CheckSquare,
  Inbox,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Sun,
  Users
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { FolderTreeIcon } from '@shared/components/icons/animated/folder-tree'

import { S } from '../strings'

interface RailCell {
  id: string
  label: string
  icon: React.ReactNode
  badge?: number
}

const TOP_CELLS: RailCell[] = [
  { id: 'mail', label: '邮件', icon: <Inbox size={19} strokeWidth={1.7} aria-hidden />, badge: 12 },
  { id: 'matters', label: '事项', icon: <CheckSquare size={19} strokeWidth={1.7} aria-hidden /> },
  { id: 'today', label: '今日', icon: <Sun size={19} strokeWidth={1.7} aria-hidden /> },
  { id: 'calendar', label: '日历', icon: <CalendarDays size={19} strokeWidth={1.7} aria-hidden /> },
  { id: 'chats', label: '会话', icon: <MessageSquare size={19} strokeWidth={1.7} aria-hidden /> },
  { id: 'contacts', label: '通讯录', icon: <Users size={19} strokeWidth={1.7} aria-hidden /> },
  { id: 'agents', label: '团队', icon: <Sparkles size={19} strokeWidth={1.7} aria-hidden /> },
  { id: 'reports', label: '报告', icon: <BarChart3 size={19} strokeWidth={1.7} aria-hidden /> },
  { id: 'groups', label: '群聊', icon: <MessagesSquare size={19} strokeWidth={1.7} aria-hidden /> },
  // rail order 9 —— design §2.1 里快照下唯一的空位。
  { id: 'library', label: S.domain, icon: <FolderTreeIcon size={19} aria-hidden /> }
]

const BOTTOM_CELLS: RailCell[] = [
  { id: 'ops', label: '运维', icon: <BarChart3 size={18} strokeWidth={1.7} aria-hidden /> },
  { id: 'settings', label: '设置', icon: <Settings size={18} strokeWidth={1.7} aria-hidden /> }
]

function RailCellButton({
  cell,
  selected,
  onEnter,
  onLeave,
  onClick
}: {
  cell: RailCell
  selected: boolean
  onEnter?(): void
  onLeave?(): void
  onClick?(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      className="nav-rail-cell"
      data-selected={selected ? 'true' : 'false'}
      aria-label={cell.label}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onClick={onClick}
    >
      <span className="railbtn">
        {cell.icon}
        {cell.badge ? <span className="railbadge">{cell.badge}</span> : null}
      </span>
      <span className="raillabel">{cell.label}</span>
    </button>
  )
}

export interface AppWindowProps {
  /** 二级栏内容（资料库 = 文件夹树）。 */
  second: React.ReactNode
  children: React.ReactNode
  /** 右侧 dock（资料库页只放一条「对话」入口占位）。 */
  dock?: React.ReactNode
  collapsed?: boolean
  onToggleCollapsed?(): void
  /** 折叠态 hover 导轨格时浮出的 peek 清单（A4）。 */
  peek?: React.ReactNode
  secondWidth?: number
  className?: string
}

/** 仿真的应用窗口。高度由外部容器给（mockup 里固定 660）。 */
export function AppWindow({
  second,
  children,
  dock,
  collapsed = false,
  onToggleCollapsed,
  peek,
  secondWidth = 336,
  className
}: AppWindowProps): React.ReactElement {
  const [peekOpen, setPeekOpen] = React.useState(false)

  return (
    <div
      className={cn('mk-window relative', className)}
      style={
        {
          '--app-second-w': collapsed ? '0px' : `${secondWidth}px`,
          '--app-nav-w': collapsed ? '56px' : `${56 + secondWidth}px`
        } as React.CSSProperties
      }
    >
      <div className="app-nav" data-collapsed={collapsed ? 'true' : 'false'}>
        <div className="nav-rail">
          <div className="nav-rail-header">
            <span className="nav-rail-avatar">陈</span>
          </div>
          <div className="nav-rail-cells">
            {TOP_CELLS.map((cell) => (
              <RailCellButton
                key={cell.id}
                cell={cell}
                selected={cell.id === 'library'}
                onEnter={() => {
                  if (collapsed && cell.id === 'library') setPeekOpen(true)
                }}
                onLeave={() => setPeekOpen(false)}
              />
            ))}
          </div>
          <div className="nav-rail-bottom">
            {BOTTOM_CELLS.map((cell) => (
              <RailCellButton key={cell.id} cell={cell} selected={false} />
            ))}
            <button
              type="button"
              className="nav-rail-toggle"
              aria-label={collapsed ? '展开二级栏' : '收起二级栏'}
              onClick={onToggleCollapsed}
            >
              {collapsed ? (
                <PanelLeftOpen size={15} strokeWidth={1.8} aria-hidden />
              ) : (
                <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden />
              )}
            </button>
          </div>
        </div>
        <div className="nav-panel">
          <div className="nav-panel-inner">{second}</div>
        </div>
        {collapsed && peek ? (
          <div
            className="nav-peek"
            data-open={peekOpen ? 'true' : 'false'}
            style={{
              position: 'absolute',
              left: 62,
              top: 8,
              bottom: 8,
              width: secondWidth,
              zIndex: 40
            }}
            onPointerEnter={() => setPeekOpen(true)}
            onPointerLeave={() => setPeekOpen(false)}
          >
            <div className="nav-peek-body overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-2xl">
              {peek}
            </div>
          </div>
        ) : null}
      </div>

      {/* PageFrame 的兄弟位语义：<main> 与 dock 并排（见 layout/PageFrame.tsx 注释）。 */}
      <main className="min-w-0 flex-1 overflow-hidden bg-ink-0">{children}</main>
      {dock}
    </div>
  )
}

/** 内容区顶栏（41px，与 rail 头 / 面板头共线）+ 面包屑。 */
export function ContentHeader({
  crumbs,
  right
}: {
  crumbs: readonly string[]
  right?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex h-[41px] shrink-0 items-center gap-2 border-b border-ink-border px-4">
      <nav aria-label="面包屑" className="flex min-w-0 flex-1 items-center gap-1.5 text-aux">
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c}-${i}`}>
            {i > 0 ? <span className="shrink-0 text-ink-fg-3">/</span> : null}
            <span
              className={cn('truncate', i === crumbs.length - 1 ? 'text-ink-fg' : 'text-ink-fg-2')}
            >
              {c}
            </span>
          </React.Fragment>
        ))}
      </nav>
      {right ? <div className="flex shrink-0 items-center gap-1.5">{right}</div> : null}
    </div>
  )
}

/** 右侧 dock 占位：资料库页只需要一条「对话」入口（design L16：不加第五档
 *  ConversationContextSource，「对话」按钮 = 预置一条 @ 提及）。 */
export function DockPlaceholder({ onChat }: { onChat?(): void }): React.ReactElement {
  return (
    <aside className="flex w-[52px] shrink-0 flex-col items-center gap-2 border-l border-ink-border bg-ink-2 py-2">
      <button
        type="button"
        onClick={onChat}
        title={`${S.act.chat}（预置一条 @ 提及）`}
        className="grid size-9 place-items-center rounded-lg text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
      >
        <Sparkles size={17} strokeWidth={1.8} aria-hidden />
      </button>
      <span className="px-1 text-center text-micro leading-tight text-ink-fg-3">对话</span>
    </aside>
  )
}
