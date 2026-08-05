// P1-4 A-1 split (2026-07-10) — list-pane header extracted verbatim from
// EmailList.tsx: Focused/Other tabs (+ GSAP sliding capsule indicator), the
// custom-folder breadcrumb, batch-mode toggle, filter popover (status /
// priority / category multi-select) and the meta count line.
// Contract: `useEmailFilter` / `useBatch` stores are read & written directly
// in here (no parent relay); only the pipeline-derived counts arrive as props.
// CSS classes (.inbox-tabs / .filter-pop / .filter-option) live in index.css
// Sprint 12 block.

import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Filter, Folder, ListChecks } from 'lucide-react'

import {
  ALL_CATEGORIES,
  ALL_PRIORITIES,
  useEmailFilter,
  type EmailCategory
} from '@shared/state/email-filter'
import { useBatch } from '@shared/state/batch'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { cn } from '@shared/lib/cn'
import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import type { AIPriority } from '@shared/api/types'

interface EmailListHeaderProps {
  /** Pipeline-derived live counts (tab-scoped) from EmailList — meta line +
   *  status filter section. */
  counts: { all: number; unread: number; flagged: number; failed: number }
  /** Per-category live count (for the filter popover hint). */
  categoryCounts: Record<EmailCategory, number>
  priorityCounts: Record<AIPriority, number>
}

export function EmailListHeader({
  counts,
  categoryCounts,
  priorityCounts
}: EmailListHeaderProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const filter = useEmailFilter((s) => s.filter)
  const setFilter = useEmailFilter((s) => s.setFilter)
  const view = useEmailFilter((s) => s.view)
  // 多文件夹同步 (P3) — 当前自定义文件夹 (mailbox=display_name); 非空时列表只拉它。
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const customMailboxPath = useEmailFilter((s) => s.customMailboxPath)
  const tab = useEmailFilter((s) => s.tab)
  const setTab = useEmailFilter((s) => s.setTab)

  // §8 滑动 indicator — Focused/Other 激活态的胶囊背景移到一个绝对定位元素,
  // 随 tab 变化 tween x/width (DUR.fast)。首次挂载 (含切回 inbox) gsap.set 直接
  // 定位无动画, 之后才滑。reduced-motion 短路。useGSAP({scope}) 自动 cleanup。
  const tabListRef = useRef<HTMLDivElement | null>(null)
  const tabIndicatorRef = useRef<HTMLSpanElement | null>(null)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      const list = tabListRef.current
      const indicator = tabIndicatorRef.current
      if (!list || !indicator) return
      const activeEl = list.querySelector<HTMLElement>('.inbox-tab.is-active')
      if (!activeEl) return
      const listRect = list.getBoundingClientRect()
      const activeRect = activeEl.getBoundingClientRect()
      // indicator 是 absolute (left:0) → 锚点在容器 padding box; 而 rect
      // 差值的参照系是 border box, 必须扣掉容器 border (clientLeft), 否则
      // x 整体右偏 1px — 激活右侧 tab 时白胶囊正好盖住容器右边框
      // (用户报「切换后边框丢失」)。
      const left = activeRect.left - listRect.left - list.clientLeft
      const width = activeRect.width
      // 「首挂 set / 后续 to」的判定必须以 DOM 真实状态为准 (revert 后
      // inline transform 为空), 🔴 不能用 ref 标志: React StrictMode 的
      // 模拟卸载会跑 useGSAP cleanup (revert 掉 gsap.set 写的 visibility/
      // x/width) 但保留 ref 值 — mount 第二跑若凭 ref 走 to 分支, autoAlpha
      // 不会再写, 胶囊从 CSS 初始 hidden 永远出不来 (「设置页往返后
      // indicator 丢失」的真根因, dev StrictMode 必现)。to 也补 autoAlpha
      // 兜底, 任何路径都不再可能停在 hidden。
      const fresh = !indicator.style.transform
      if (fresh || reduceMotion) {
        gsap.set(indicator, { x: left, width, autoAlpha: 1 })
        return
      }
      gsap.to(indicator, { x: left, width, autoAlpha: 1, duration: DUR.fast, overwrite: 'auto' })
    },
    // i18n.language 在依赖里: tab 文本宽度随语言变 (重点 vs Focused),
    // 不重测会让胶囊保持旧语言的宽度 → 英文文本溢出胶囊。
    { dependencies: [tab, view, reduceMotion, i18n.language], scope: tabListRef }
  )
  const selectedPriorities = useEmailFilter((s) => s.selectedPriorities)
  const selectedCategories = useEmailFilter((s) => s.selectedCategories)
  const togglePriority = useEmailFilter((s) => s.togglePriority)
  const toggleCategory = useEmailFilter((s) => s.toggleCategory)
  const setPriorities = useEmailFilter((s) => s.setPriorities)
  const setCategories = useEmailFilter((s) => s.setCategories)
  const allPrioritiesSelected = useEmailFilter((s) => s.allPrioritiesSelected)
  const allCategoriesSelected = useEmailFilter((s) => s.allCategoriesSelected)
  const resetAll = useEmailFilter((s) => s.resetAll)

  const batchMode = useBatch((s) => s.mode)
  const enterBatch = useBatch((s) => s.enter)
  const exitBatch = useBatch((s) => s.exit)

  const [filterOpen, setFilterOpen] = useState(false)
  // Sprint 12.6 user-feedback — outside-click previously checked the whole
  // header container, which meant clicking on the inbox tabs / batch button
  // inside the header kept the popover open. We now scope the "inside"
  // check to just the popover + its trigger button, so clicking anywhere
  // else (header whitespace, list rows, status bar, …) closes it.
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  // Filter popover 出入场：无 backdrop，从右上微展开（CSS `.filter-pop` 锚定
  // top:100%+4px / right:8px，即从触发按钮下方右上角展开），退场反向后延迟卸载。
  // scopeRef 挂在 `.filter-pop` 上，兼作 outside-click 命中判定的容器 ref。
  const { shouldRender: filterShouldRender, scopeRef: filterPopoverRef } =
    useExitAnimation<HTMLDivElement>(filterOpen, {
      backdrop: false,
      from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' },
      enterDuration: DUR.fast
    })

  // Outside-click + Esc → close filter popover
  useEffect(() => {
    if (!filterOpen) return
    function onClickAway(ev: MouseEvent): void {
      const target = ev.target as Node | null
      if (!target) return
      if (filterPopoverRef.current?.contains(target)) return
      if (filterTriggerRef.current?.contains(target)) return
      setFilterOpen(false)
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') setFilterOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickAway)
      document.removeEventListener('keydown', onKey)
    }
  }, [filterOpen, filterPopoverRef])

  const priActive = !allPrioritiesSelected()
  const catActive = !allCategoriesSelected()
  const filterActive = filter !== 'all' || priActive || catActive

  return (
    /* Header — Focused/Other tabs · batch + filter cluster · meta line */
    /* 分割线统一 hairline — 与 sidebar header / AgentsPage tab 条同色连贯。 */
    <div className="relative px-3 pt-3 pb-2.5 border-b [border-bottom-color:var(--hairline)]">
      <div className="flex items-center justify-between gap-2">
        {customMailbox ? (
          // 多文件夹同步 (P3) — 选中自定义文件夹时左侧显层级面包屑 (界面④)。
          // 末段 = 当前文件夹 (高亮), 前缀段为父路径 (弱化), 中间用 chevron 分隔。
          <div className="flex items-center gap-1 min-w-0" aria-label={t('list.folderCrumb.aria')}>
            <Folder size={14} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
            {(customMailboxPath.length > 0 ? customMailboxPath : [customMailbox]).map(
              (seg, i, arr) => {
                const isLast = i === arr.length - 1
                return (
                  <Fragment key={`${seg}-${i}`}>
                    {i > 0 ? (
                      <ChevronRight size={12} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
                    ) : null}
                    <span
                      className={cn(
                        'truncate text-aux',
                        isLast ? 'font-semibold text-ink-fg' : 'text-ink-fg-2'
                      )}
                    >
                      {seg}
                    </span>
                  </Fragment>
                )
              }
            )}
          </div>
        ) : view === 'inbox' ? (
          <div
            ref={tabListRef}
            className="inbox-tabs"
            role="tablist"
            aria-label={t('list.tab.aria')}
          >
            {/* §8 滑动 indicator — 胶囊背景跟随激活 tab 滑动 (JS 测量 + GSAP x/width)。 */}
            <span ref={tabIndicatorRef} className="inbox-tab-indicator" aria-hidden="true" />
            <button
              type="button"
              className={tab === 'focused' ? 'inbox-tab is-active' : 'inbox-tab'}
              role="tab"
              aria-selected={tab === 'focused'}
              onClick={() => setTab('focused')}
            >
              {t('list.tab.focused')}
            </button>
            <button
              type="button"
              className={tab === 'other' ? 'inbox-tab is-active' : 'inbox-tab'}
              role="tab"
              aria-selected={tab === 'other'}
              onClick={() => setTab('other')}
            >
              {t('list.tab.other')}
            </button>
          </div>
        ) : (
          // 非收件箱视图无 focused/other 分流, 用视图标题占左侧 (保 justify-between
          // 布局: 右侧 batch/filter 簇仍靠右), 同时告诉用户当前在哪个视图。
          <div className="text-aux font-semibold text-ink-fg truncate">
            {view === 'outbox'
              ? t('nav.outbox')
              : view === 'drafts'
                ? t('nav.drafts')
                : view === 'flagged'
                  ? t('nav.flagged')
                  : t('nav.allMail')}
          </div>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={
              // 主题 v3 C8/批 4: 工具钮档 rounded-md(6) → token 化 --r-ctl
              batchMode === 'on'
                ? 'w-7 h-7 rounded-[var(--r-ctl)] text-coral bg-coral/10 flex items-center justify-center transition-colors duration-fast'
                : 'w-7 h-7 rounded-[var(--r-ctl)] text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 flex items-center justify-center transition-colors duration-fast'
            }
            title={batchMode === 'on' ? t('list.batch.exit') : t('list.batch.enter')}
            aria-label={batchMode === 'on' ? t('list.batch.exit') : t('list.batch.enter')}
            aria-pressed={batchMode === 'on'}
            onClick={() => (batchMode === 'on' ? exitBatch() : enterBatch())}
          >
            <ListChecks size={13} strokeWidth={2} />
          </button>
          <button
            ref={filterTriggerRef}
            type="button"
            className="filter-btn w-7 h-7 rounded-[var(--r-ctl)] text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 flex items-center justify-center transition-colors duration-fast"
            title={t('list.filter.button')}
            aria-label={t('list.filter.button')}
            aria-haspopup="true"
            aria-expanded={filterOpen}
            aria-controls="filter-pop"
            data-active={filterActive ? 'true' : 'false'}
            onClick={() => setFilterOpen((o) => !o)}
          >
            <Filter size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
        <span className="tabular-nums">
          {counts.unread} {t('list.meta.unread')}
        </span>
        <span className="text-ink-fg-3">·</span>
        <span className="tabular-nums">
          {t('list.meta.total')} {counts.all}
        </span>
        {filterActive && (
          <>
            <span className="text-ink-fg-3">·</span>
            <button
              type="button"
              className="text-coral hover:text-coral-hover transition-colors duration-fast"
              onClick={() => {
                resetAll()
                setFilter('all')
              }}
            >
              {t('list.filter.reset')}
            </button>
          </>
        )}
      </div>

      {filterShouldRender && (
        <div
          ref={filterPopoverRef}
          id="filter-pop"
          className="filter-pop glass-pop"
          role="dialog"
          aria-label={t('list.filter.button')}
        >
          <FilterSection
            title={t('list.filter.status')}
            onSelectAll={() => setFilter('all')}
            onClear={() => setFilter('all')}
          >
            {(['all', 'unread', 'flagged', 'failed'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                className="filter-option"
                data-checked={filter === opt ? 'true' : 'false'}
                onClick={() => setFilter(opt)}
              >
                <span className="cb-mini" aria-hidden />
                <span className="label">
                  {opt === 'all' ? t('list.filter.all') : t(`emailList.filter.${opt}`)}
                </span>
                <span className="count tabular-nums">
                  {opt === 'all' ? counts.all : counts[opt]}
                </span>
              </button>
            ))}
          </FilterSection>

          <FilterSection
            title={t('list.filter.priority')}
            onSelectAll={() => setPriorities(new Set(ALL_PRIORITIES))}
            onClear={() => setPriorities(new Set())}
          >
            {ALL_PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                className="filter-option"
                data-checked={selectedPriorities.has(p) ? 'true' : 'false'}
                onClick={() => togglePriority(p)}
              >
                <span className="cb-mini" aria-hidden />
                <span className={`pri-dot ${priDotClass(p)}`} aria-hidden />
                <span className="label">{capitalize(p)}</span>
                <span className="count tabular-nums">{priorityCounts[p]}</span>
              </button>
            ))}
          </FilterSection>

          <FilterSection
            title={t('list.filter.category')}
            onSelectAll={() => setCategories(new Set(ALL_CATEGORIES))}
            onClear={() => setCategories(new Set())}
          >
            {ALL_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className="filter-option"
                data-checked={selectedCategories.has(c) ? 'true' : 'false'}
                onClick={() => toggleCategory(c)}
              >
                <span className="cb-mini" aria-hidden />
                {/* LLM CATEGORY_ENUM is emoji-prefixed Chinese; we render
                    the verbatim string so the popover matches what the
                    backend stores. Future EN locale would translate the
                    tail of the string, not the leading emoji. */}
                <span className="label">{c}</span>
                <span className="count tabular-nums">{categoryCounts[c]}</span>
              </button>
            ))}
          </FilterSection>
        </div>
      )}
    </div>
  )
}

// ─── Header-only helpers (moved with the header JSX) ─────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Priority dot uses the same Tailwind tokens as the EmailRow .pdot states.
// No raw hex — DESIGN.md §14 #1 routes every chip colour through the
// `--c-{crit,urg,impt,norm,low}` variables exposed in index.css.
const PRIORITY_DOT_CLASS: Record<AIPriority, string> = {
  critical: 'bg-crit',
  urgent: 'bg-urg',
  important: 'bg-impt',
  normal: 'bg-norm',
  low: 'bg-low'
}
function priDotClass(p: AIPriority): string {
  return PRIORITY_DOT_CLASS[p]
}

function FilterSection({
  title,
  onSelectAll,
  onClear,
  children
}: {
  title: string
  onSelectAll: () => void
  onClear: () => void
  children: React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="filter-section">
      <div className="filter-section-head">
        <span>{title}</span>
        <span className="links">
          <button type="button" onClick={onSelectAll}>
            {t('list.filter.selectAll')}
          </button>
          <button type="button" onClick={onClear}>
            {t('list.filter.clearLink')}
          </button>
        </span>
      </div>
      {children}
    </div>
  )
}
