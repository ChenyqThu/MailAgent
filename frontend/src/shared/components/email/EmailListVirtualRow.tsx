// P1-4 A-1 split (2026-07-10) — react-window row renderer extracted verbatim
// from EmailList.tsx. Unlike the emailListRows.ts pure helpers this is a real
// React component (it calls useTranslation), but it reads only its props —
// never EmailList's local state — so the seam is a clean props contract.

import { useTranslation } from 'react-i18next'
import type { RowComponentProps } from 'react-window'

import type { GroupKey } from '@shared/state/group-collapse'

import { EmailRow } from './EmailRow'
import type { ListRow } from './emailListRows'

export interface RowProps {
  rows: ReadonlyArray<ListRow>
  activeId: number | null
  newIds: ReadonlySet<number>
  onSelect(id: number): void
  onToggleGroup(key: GroupKey): void
  onToggleThread(threadId: string): void
  onExpandThread(threadId: string, headInternalId: number): void
  /** 刚被展开的线程 —— 其子行播一次入场动画。见下方 data-thread-reveal 注释。 */
  revealThreadId: string | null
}

export function VirtualRow({
  index,
  style,
  rows,
  // activeId is folded into `item.bundleSelected` at flatten time so the
  // row component itself only needs the rest.  The prop stays in
  // RowProps so the List parent re-renders rows when active changes.
  newIds,
  onSelect,
  onToggleGroup,
  onToggleThread,
  onExpandThread,
  revealThreadId
}: RowComponentProps<RowProps>): React.ReactElement {
  // Aliased `tRow` — the `email` branch below shadows `t` with `item.thread` (pre-existing,
  // unrelated to i18n), so a plain `const { t } = useTranslation()` here would collide with it.
  const { t: tRow } = useTranslation()
  const item = rows[index]
  if (!item) return <div style={style} />
  if (item.type === 'loader') {
    return (
      <div style={style} className="px-4 py-3 text-center text-meta font-mono text-ink-fg-3">
        {tRow('emailList.loadingMore')}
      </div>
    )
  }
  if (item.type === 'header') {
    return (
      <div style={style}>
        <header
          className="group-header"
          role="button"
          tabIndex={0}
          aria-expanded={!item.collapsed}
          onClick={() => onToggleGroup(item.key)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onToggleGroup(item.key)
            }
          }}
          data-collapsed={item.collapsed ? 'true' : 'false'}
        >
          <svg className="group-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {item.key === 'pinned' && (
            <svg className="group-pin-glyph" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 4v6.59l3.71 3.71A1 1 0 0 1 19 16h-6v5l-1 1-1-1v-5H5a1 1 0 0 1-.71-1.71L8 10.59V4a1 1 0 0 1-1-1V2h10v1a1 1 0 0 1-1 1z" />
            </svg>
          )}
          <span>{item.label}</span>
          <span className="group-count">{item.count}</span>
        </header>
      </div>
    )
  }
  // Sprint 17 — thread chevron 从外层 div 移到 EmailRow grid 第一格 (.email-row
  // > .thread-chevron-cell). flag / done / selected wash + 未读 dot 现在共享同
  // 一个 article 容器, 染色和定位能 cover chevron 区域. data-thread='head|child|
  // none' 在 EmailRow article 上, CSS 据此渲染竖向 tether 线 (child).
  const t = item.thread
  const isHead = t?.isHead === true
  const isChild = t !== undefined && !t.isHead
  const threadChevron = t
    ? {
        isHead,
        isChild,
        // 仅 head 行有 expanded 字段; child 不渲染 chevron 所以 false 即可
        expanded: t.isHead ? t.expanded : false,
        // chevron = 切换 (手风琴): 展开态点击 → 仅折叠 (头不动, 无需滚动锚定);
        // 折叠态点击 → 展开本线程 + 选中母邮件 (onExpandThread 内部做滚动锚定).
        onToggle: isHead
          ? () => {
              if (t.expanded) {
                onToggleThread(t.threadId)
              } else {
                onExpandThread(t.threadId, item.email.internal_id)
                onSelect(item.email.internal_id)
              }
            }
          : undefined
      }
    : undefined
  // 点击母邮件行体 = 加载详情 + 强制展开本线程 (手风琴: 折叠其它已展开线程).
  // 行体点击只会展开, 不会折叠已展开的本线程 (收起须点 chevron). 子邮件 / 单封仅选中.
  const handleSelect =
    isHead && t
      ? () => {
          onSelect(item.email.internal_id)
          onExpandThread(t.threadId, item.email.internal_id)
        }
      : () => onSelect(item.email.internal_id)
  // 线程展开入场: 只给「刚展开的那条线程」的子行播一次 (母邮件行不动, 它本来就在)。
  //
  // 🔴 判据是 revealThreadId 而**不是** t.expanded —— 列表虚拟化, 子行随滚动卸载
  // 重挂, 按 expanded 驱动的话每次滚回视口都重播一遍。revealThreadId 由 hook 在
  // REVEAL_WINDOW_MS 后清掉, 之后重挂的行是静态的。
  //
  // 🔴 CSS 里只能动 opacity + **独立 translate 属性**: 行定位是 react-window 写在
  // style 上的 (v2 用 top, 但独立 translate 与任何 transform 都能复合, 不留隐患)。
  // 单独取窄类型: isChild 是布尔量, TS 不会据它把 t 收窄到 child 变体 (childIndex 只在 child 上)。
  const childInfo = t !== undefined && !t.isHead ? t : null
  const revealing = childInfo !== null && childInfo.threadId === revealThreadId
  return (
    <div
      style={
        childInfo !== null && revealing
          ? // stagger 序号封顶 —— 30 封的线程不该让最后一行等 700ms 才出来。
            ({
              ...style,
              '--thread-reveal-i': Math.min(childInfo.childIndex, 6)
            } as React.CSSProperties)
          : style
      }
      data-thread-reveal={revealing ? 'true' : undefined}
    >
      <EmailRow
        email={item.email}
        selected={item.bundleSelected}
        isNew={newIds.has(item.email.internal_id)}
        noAvatar={isChild}
        threadChevron={threadChevron}
        onSelect={handleSelect}
      />
    </div>
  )
}
