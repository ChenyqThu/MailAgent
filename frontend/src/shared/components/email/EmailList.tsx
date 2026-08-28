// Sprint 12 — Inbox list pane per mockup-inbox.html lines 1430-2596.
// Sprint 12.5 adds:
//   • Focused / Other tab dual-bucket (focused = signal mail; other =
//     low-priority + auto-archive bucket).
//   • Filter popover with priority + category multi-select.
//   • Date group headers with click-to-collapse persistence.
//   • Pinned virtual group at the top (driven by usePinned localStorage).
//   • Infinite scroll — initial 100 rows, +100 each time the list nears
//     the end (react-window v2 onRowsRendered).
//   • Real batch mode (cb checkboxes via row + floating BatchActionBar).
//
// P1-4 A-1/A-2 split (2026-07-10) — this file is now the thin JSX shell:
// it calls useEmailListRows(), mounts the keyboard hooks and assembles
// Header / List / BatchActionBar. The extracted seams:
//   • hooks/useEmailListRows.ts — the entire data pipeline (5 useQuery →
//     filter/group/paginate → rows/rowHeights, scroll anchoring, snippet
//     lazy-fetch, paging) behind a single return contract
//   • emailListRows.ts        — pure filter/group/flatten/row-height helpers
//   • EmailListVirtualRow.tsx — react-window row renderer (RowProps contract)
//   • EmailListHeader.tsx     — tabs / GSAP indicator / filter popover / batch
//     toggle (reads useEmailFilter + useBatch stores directly; only the
//     pipeline-derived counts arrive as props)

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { List } from 'react-window'
import { Mail } from 'lucide-react'

import { useActiveEmail } from '@shared/state/active-email'
import { useGroupCollapse } from '@shared/state/group-collapse'
import { useEmailKeyboardNav } from '@shared/hooks/useEmailKeyboardNav'
import { useInboxActionShortcuts } from '@shared/hooks/useInboxActionShortcuts'
import { useEmailListRows } from '@shared/hooks/useEmailListRows'
import { errorMessage } from '@shared/lib/ipcErrors'

import { BatchActionBar } from './BatchActionBar'
import { EmailListHeader } from './EmailListHeader'
import { VirtualRow, type RowProps } from './EmailListVirtualRow'

export function EmailList(): React.ReactElement {
  const { t } = useTranslation()
  // Store actions the JSX hands to VirtualRow (stable references; the
  // pipeline hook subscribes to the state slices it derives from itself).
  const setActive = useActiveEmail((s) => s.setActive)
  const toggleGroup = useGroupCollapse((s) => s.toggle)

  const {
    rows,
    getRowHeight,
    orderedIds,
    activeId,
    newIds,
    counts,
    userEmail,
    categoryCounts,
    priorityCounts,
    selectedAllFlagged,
    isLoading,
    isError,
    error,
    listRef,
    handleRowsRendered,
    handleToggleThread,
    handleExpandThread,
    revealThreadId
  } = useEmailListRows()

  useEmailKeyboardNav(orderedIds)
  useInboxActionShortcuts()

  // 08-27 标签工作区：点行 = 开标签（去重激活在 store），标题从行数据带上（避免新标签
  // 顶着空标题等详情回填）。rows 走 ref —— 放进 useCallback 依赖会让 5s poll 的每次
  // rows 变化都换回调引用，react-window 把可见行全部重渲一遍。
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const handleSelect = useCallback(
    (id: number): void => {
      let title: string | undefined
      for (const row of rowsRef.current) {
        if (row.type === 'email' && row.email.internal_id === id) {
          title = row.email.subject ?? undefined
          break
        }
      }
      setActive(id, title !== undefined && title !== '' ? { title } : undefined)
    },
    [setActive]
  )

  return (
    <section
      aria-label="email-list"
      // EMAIL-02 响应式：<lg 列表占满 master-detail 容器（详情走 absolute 覆盖）。
      // #6 — 宽度由父层 InboxLayout wrapper 控制 (≥lg 用户可拖拽调整 + localStorage
      // 记忆, default 340; <lg 占满)。本组件 w-full 填满 wrapper, 不再自带固定列宽。
      className="w-full glass-2 border-r border-ink-border flex flex-col min-h-0"
    >
      {/* Header — Focused/Other tabs · batch + filter cluster · meta line
          (extracted to EmailListHeader.tsx; reads filter/batch stores itself). */}
      <EmailListHeader
        counts={counts}
        categoryCounts={categoryCounts}
        priorityCounts={priorityCounts}
        userEmail={userEmail}
      />

      {/* Sprint 12.6 — removed the "N 封新邮件 · 点击查看" CTA pill. The
          list already auto-refreshes every 5s (refetchInterval), so newly
          arrived mail surfaces at the top without any click. The row-level
          NEW chip (driven by useNewlyAddedIds) still flashes for 2s as a
          visual "just-arrived" cue. */}

      <div className="flex-1 min-h-0">
        {isLoading && (
          <div className="p-6 text-aux text-ink-fg-2 animate-pulse motion-reduce:animate-none">
            {t('emailList.loading')}
          </div>
        )}
        {isError && <div className="p-6 text-aux text-fail">{errorMessage(error)}</div>}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="px-6 py-12 text-center text-aux text-ink-fg-2">
            <Mail size={20} strokeWidth={1.5} className="inline-block opacity-30 mb-2" />
            <div>{t('empty.state')}</div>
          </div>
        )}
        {!isLoading && !isError && rows.length > 0 && (
          <List<RowProps>
            listRef={listRef}
            rowComponent={VirtualRow}
            rowCount={rows.length}
            rowHeight={getRowHeight}
            rowProps={{
              rows,
              activeId,
              newIds,
              onSelect: handleSelect,
              onToggleGroup: toggleGroup,
              onToggleThread: handleToggleThread,
              onExpandThread: handleExpandThread,
              revealThreadId
            }}
            onRowsRendered={handleRowsRendered}
            // 主题 v3 tweak (2026-07-12): scrollbar-thin 的 8px 经典槽位即使
            // thumb 透明也占布局 → 列表右缘留白。owner 拍板无滚动条设计:
            // scrollbar-none 零槽位, 滚动靠触控板/j·k, 药丸右缘贴齐列表边。
            className="scrollbar-none"
            style={{ height: '100%' }}
          />
        )}
      </div>

      <BatchActionBar visibleIds={orderedIds} selectedAllFlagged={selectedAllFlagged} />
    </section>
  )
}
