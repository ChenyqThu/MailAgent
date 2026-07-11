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
  /** Sprint 19 — 懒取的正文 snippet (internal_id → 前 100 字)。listEnriched 不再
   *  读 body blob, 这里按可见行填充; VirtualRow 合并进 email.snippet 渲染预览。 */
  snippets: Record<number, string>
  onSelect(id: number): void
  onToggleGroup(key: GroupKey): void
  onToggleThread(threadId: string): void
  onExpandThread(threadId: string, headInternalId: number): void
}

export function VirtualRow({
  index,
  style,
  rows,
  // activeId is folded into `item.bundleSelected` at flatten time so the
  // row component itself only needs the rest.  The prop stays in
  // RowProps so the List parent re-renders rows when active changes.
  newIds,
  snippets,
  onSelect,
  onToggleGroup,
  onToggleThread,
  onExpandThread
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
  // Sprint 19 — 合并懒取的 snippet。仅当原 email 无 snippet 且 map 有值时新建对象,
  // 否则复用原引用 (EmailRow memo 按字段比较, snippet 变化才重渲该行)。
  const liveSnippet = snippets[item.email.internal_id]
  const emailForRow =
    liveSnippet && !item.email.snippet ? { ...item.email, snippet: liveSnippet } : item.email
  return (
    <div style={style}>
      <EmailRow
        email={emailForRow}
        selected={item.bundleSelected}
        isNew={newIds.has(item.email.internal_id)}
        noAvatar={isChild}
        threadChevron={threadChevron}
        onSelect={handleSelect}
      />
    </div>
  )
}
