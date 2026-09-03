// P1-4 A-1 split (2026-07-10) — list-pane header extracted verbatim from
// EmailList.tsx: Focused/Other tabs (+ GSAP sliding capsule indicator), the
// custom-folder breadcrumb, batch-mode toggle, filter popover (status /
// priority / category multi-select) and the meta count line.
// Contract: `useEmailFilter` / `useBatch` stores are read & written directly
// in here (no parent relay); only the pipeline-derived counts arrive as props.
// CSS classes (.inbox-tabs / .filter-btn / .list-cta) live in index.css。
//
// task 08-27 P1 Lane B —— 两行列表头（原型 TabAnatomy「列表头：邮件双行」）：
//   第一行  文件夹选择器（下拉，取代常驻文件夹树）· pin 的文件夹图标（有未读带红点）
//           · 写邮件实心 CTA
//   第二行  重点/其他分栏 + 「N 未读 · 共 M」左对齐紧跟其后；批量与筛选推到右端
// 🔴 非收件箱视图只是分栏消失，第二行**行高不变**（高度由右端 28px 工具钮定，不由
// 24px 分栏定）—— 切文件夹时列表不能跳。老的自定义文件夹面包屑随之退役：当前文件夹
// 名现在由第一行的选择器承载（完整路径在 title 上）。
//
// 2026-08 筛选/排序菜单重做（Outlook 结构 + 下钻面板交互）：
//   • 旧的手搓 `.filter-pop`（三段平铺 + 自管 outside-click/Esc/退场动画）换成
//     全 app 的弹层基座 `ui/Popmenu`（移植自 lab.moumen.dev 的 unlimited-nested-
//     menu）；本文件只负责**把 store 翻译成菜单项**。
//   • 状态单选 chip（全部/未读/已标旗/同步失败）退役 → 六条独立筛选项 + 两个
//     下钻子面板（优先级 / 分类），AND 组合。
//   • 新增「排序依据」「方向」两组单选 —— 排序下沉到 SQL（见 @shared/lib/emailSort）。
//   • 方向文案随排序键切换（Outlook 同款）：日期=由新到旧、重要性=由高到低、
//     文本=A→Z。owner 拟稿里只写了日期口径的两个词，照抄会让「按发件人 · 由新到旧」
//     这种自相矛盾的组合出现在菜单里。

import { useCallback, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Filter, ListChecks } from 'lucide-react'

import {
  ALL_CATEGORIES,
  ALL_PRIORITIES,
  useEmailFilter,
  type EmailCategory
} from '@shared/state/email-filter'
import { useBatch } from '@shared/state/batch'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useSyncedFolderTree } from '@shared/hooks/useSyncedFolderTree'
import { useFolderPrefMap } from '@shared/hooks/useFolderPrefs'
import { MAIL_VIEW_ENTRIES, useSelectMailbox } from '@shared/hooks/useSelectMailbox'
import { cn } from '@shared/lib/cn'
import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { EMAIL_SORT_KEYS, type EmailSortKey } from '@shared/lib/emailSort'
import { flattenFolderTree } from '@shared/lib/folderTree'
import { folderUnreadCount, mailboxViewCount, viewCountIsUnread } from '@shared/lib/mailboxCounts'
import { qk } from '@shared/lib/queryKeys'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { FolderGlyph, SquarePenIcon } from '@shared/components/icons'
import { navLabel } from '@shared/navigation/registry'
import { openNewCompose } from '@shared/state/compose-new'
import { MAX_PINNED_FOLDERS, pinnedFolderKey, usePinnedFolders } from '@shared/state/pinned-folders'
import { toastInfo } from '@shared/state/toast'
import type { AIPriority } from '@shared/api/types'

import { FolderMenu } from './FolderMenu'

interface EmailListHeaderProps {
  /** Pipeline-derived live counts (tab-scoped) from EmailList — meta line +
   *  每条筛选轴各自的「只开这一条会剩多少」。 */
  counts: {
    all: number
    unread: number
    flagged: number
    done: number
    toMe: number
    hasAttach: number
    failed: number
  }
  /** Per-category live count (for the filter popover hint). */
  categoryCounts: Record<EmailCategory, number>
  priorityCounts: Record<AIPriority, number>
  /** USER_EMAIL —— null 时「收件人是我」置灰（判据取不到，不给假开关）。 */
  userEmail: string | null
}

// 优先级色点走与 EmailRow .pdot 同一套 Tailwind token（DESIGN.md §14 #1：不写裸
// hex，全部经 `--c-{crit,urg,impt,norm,low}`）。旧的平铺 popover 有这枚点，重做时
// 不能丢 —— 只剩五个中文词的话，列表行上的颜色编码在筛选面就断了。
const PRIORITY_DOT_CLASS: Record<AIPriority, string> = {
  critical: 'bg-crit',
  urgent: 'bg-urg',
  important: 'bg-impt',
  normal: 'bg-norm',
  low: 'bg-low'
}

/** 方向两档的文案 key 随排序键变 —— 「按发件人 · 由新到旧」是无意义组合。 */
const DIR_LABEL_KEY: Record<EmailSortKey, { desc: string; asc: string }> = {
  date: { desc: 'list.sort.dir.newest', asc: 'list.sort.dir.oldest' },
  sender: { desc: 'list.sort.dir.za', asc: 'list.sort.dir.az' },
  subject: { desc: 'list.sort.dir.za', asc: 'list.sort.dir.az' },
  importance: { desc: 'list.sort.dir.highest', asc: 'list.sort.dir.lowest' }
}

export function EmailListHeader({
  counts,
  categoryCounts,
  priorityCounts,
  userEmail
}: EmailListHeaderProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const view = useEmailFilter((s) => s.view)
  // 多文件夹同步 (P3) — 当前自定义文件夹 (mailbox=display_name); 非空时列表只拉它。
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const customMailboxPath = useEmailFilter((s) => s.customMailboxPath)
  const tab = useEmailFilter((s) => s.tab)
  const setTab = useEmailFilter((s) => s.setTab)
  // 点行语义（内建视图 / 自定义文件夹）与折叠态 peek 的邮箱列表共用同一个 hook。
  const { selectView, selectFolder } = useSelectMailbox()
  /** 收件箱视图（有分栏的那一档）—— 自定义文件夹与其余内建视图都没有重点/其他。 */
  const isInboxView = customMailbox === null && view === 'inbox'

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
    // customMailbox 也在依赖里: 切到自定义文件夹会把整条 tab 条卸载, 切回来是**新的**
    // DOM 而 view 全程没变 —— 少了它 effect 不重跑, 胶囊停在 CSS 初始 hidden。
    { dependencies: [tab, view, customMailbox, reduceMotion, i18n.language], scope: tabListRef }
  )

  const unread = useEmailFilter((s) => s.unread)
  const flagMark = useEmailFilter((s) => s.flagMark)
  const toMe = useEmailFilter((s) => s.toMe)
  const hasAttach = useEmailFilter((s) => s.hasAttach)
  const failed = useEmailFilter((s) => s.failed)
  const toggleBool = useEmailFilter((s) => s.toggleBool)
  const toggleFlagMark = useEmailFilter((s) => s.toggleFlagMark)
  const selectedPriorities = useEmailFilter((s) => s.selectedPriorities)
  const selectedCategories = useEmailFilter((s) => s.selectedCategories)
  const togglePriority = useEmailFilter((s) => s.togglePriority)
  const toggleCategory = useEmailFilter((s) => s.toggleCategory)
  const setPriorities = useEmailFilter((s) => s.setPriorities)
  const setCategories = useEmailFilter((s) => s.setCategories)
  const sortKey = useEmailFilter((s) => s.sortKey)
  const sortDir = useEmailFilter((s) => s.sortDir)
  const setSort = useEmailFilter((s) => s.setSort)
  const setSortDir = useEmailFilter((s) => s.setSortDir)
  const hasActiveFilter = useEmailFilter((s) => s.hasActiveFilter)
  const resetAll = useEmailFilter((s) => s.resetAll)

  const batchMode = useBatch((s) => s.mode)
  const enterBatch = useBatch((s) => s.enter)
  const exitBatch = useBatch((s) => s.exit)

  const [filterOpen, setFilterOpen] = useState(false)
  const filterTriggerRef = useRef<HTMLButtonElement>(null)

  // ── 文件夹选择器（第一行）─────────────────────────────────────────────
  const [folderOpen, setFolderOpen] = useState(false)
  const folderTriggerRef = useRef<HTMLButtonElement>(null)
  const { tree } = useSyncedFolderTree()
  const prefMap = useFolderPrefMap()
  const pinned = usePinnedFolders((s) => s.pinned)

  const notifyPinLimit = useCallback((): void => {
    toastInfo(t('list.folder.pinLimit', { count: MAX_PINNED_FOLDERS }))
  }, [t])

  // pin chip 的未读点数据源 —— 与下拉（FolderMenu）、折叠态 peek、侧栏徽标同一份缓存
  // （SSE 失效 + Sidebar 兜底轮询已经在喂这个 key），这里只是又一个 observer。
  // 🔴 不加 `enabled`：chip 常驻第一行，下拉关着时也得知道有没有未读。
  const mailApi = useMailApi()
  const { data: mailboxData } = useQuery({
    queryKey: qk.mailboxes(),
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000
  })
  const mailboxes = mailboxData ?? []

  // pin 图标解析：内建视图取 registry 的图标/标签；自定义文件夹按**当前**树解析
  // （文件夹被移出白名单时退回兜底图标 + 存下的完整名，不自动清 pin）。
  const flatFolders = flattenFolderTree(tree)
  const pinChips = pinned.map((pin) => {
    if (pin.kind === 'view') {
      const entry = MAIL_VIEW_ENTRIES.find((e) => e.view === pin.view)
      return {
        pin,
        label: entry ? navLabel(entry, t) : pin.view,
        // 图标不裹 AnimatedIconActiveProvider —— standalone 档（默认 trigger='self'）
        // 自己挂 hover，裹上等于把动画钉死在 normal。
        icon: entry ? entry.icon() : null,
        // 🔴 判据不是「计数 > 0」而是「这一档的计数口径是未读」（口径单源在
        // lib/mailboxCounts）：草稿箱给的是总数，拿它画红点会把「草稿箱有 1 封」读成「有未读」。
        unread: viewCountIsUnread(pin.view) && (mailboxViewCount(mailboxes, pin.view) ?? 0) > 0,
        active: customMailbox === null && view === pin.view,
        onClick: () => selectView(pin.view)
      }
    }
    const node = flatFolders.find((f) => f.node.fullDisplayName === pin.mailbox)?.node
    return {
      pin,
      label: node?.displayName ?? pin.mailbox,
      // 未读判据用**存下的完整名**（= email_metadata.mailbox），不用 node —— 文件夹被移出
      // 白名单时 node 解析不到，但 pin 还在，chip 也还在。
      unread: folderUnreadCount(mailboxes, pin.mailbox) > 0,
      icon: (
        <FolderGlyph
          iconKey={node ? prefMap.get(node.imapName)?.icon : null}
          size={15}
          strokeWidth={1.75}
          className="shrink-0"
        />
      ),
      active: customMailbox === pin.mailbox,
      onClick: () => {
        if (node) selectFolder(node)
      }
    }
  })

  /** 选择器上显示的当前位置：自定义文件夹用叶子段（完整路径进 title），内建视图用
   *  registry 的标签。列宽只有 336，面包屑放不下 —— 层级在下拉里看。 */
  const currentFolderNode = customMailbox
    ? flatFolders.find((f) => f.node.fullDisplayName === customMailbox)?.node
    : undefined
  const currentViewEntry = MAIL_VIEW_ENTRIES.find((e) => e.view === view) ?? MAIL_VIEW_ENTRIES[0]
  const currentLabel = customMailbox
    ? (customMailboxPath.at(-1) ?? customMailbox)
    : navLabel(currentViewEntry, t)
  const currentTitle = customMailbox ?? currentLabel
  const currentIcon = customMailbox ? (
    <FolderGlyph
      iconKey={currentFolderNode ? prefMap.get(currentFolderNode.imapName)?.icon : null}
      size={15}
      strokeWidth={1.75}
      className="shrink-0 text-ink-fg-2"
    />
  ) : (
    currentViewEntry.icon()
  )

  // 三条最常用筛选轴的直达键（keymap.ts 已登记 scope=inbox）。菜单**关着**也生效
  // —— 这些键的价值就在于不必先打开菜单。
  // useCallback 不是装饰：useShortcut 的 effect 依赖 handler 引用，内联箭头函数会让
  // 它每次 render 都退订重订（列表面每 5s 轮询就重渲一轮）。zustand action 引用稳定。
  const kbUnread = useCallback(() => {
    toggleBool('unread')
    return true
  }, [toggleBool])
  const kbFlagged = useCallback(() => {
    toggleFlagMark('flagged')
    return true
  }, [toggleFlagMark])
  const kbAttach = useCallback(() => {
    toggleBool('hasAttach')
    return true
  }, [toggleBool])
  useShortcut('shift+cmd+o', kbUnread)
  useShortcut('alt+cmd+o', kbFlagged)
  useShortcut('shift+cmd+a', kbAttach)

  const priCount = selectedPriorities.size
  const catCount = selectedCategories.size
  const filterActive = hasActiveFilter()

  const items: PopmenuItem[] = [
    { kind: 'label', id: 'filter-head', label: t('list.filter.title') },
    {
      kind: 'checkbox',
      id: 'unread',
      label: t('emailList.filter.unread'),
      checked: unread,
      count: counts.unread,
      shortcut: '⇧⌘O',
      onToggle: () => toggleBool('unread')
    },
    {
      kind: 'submenu',
      id: 'flagMark',
      label: t('list.filter.flagMark'),
      hint:
        flagMark === null
          ? undefined
          : flagMark === 'flagged'
            ? t('emailList.filter.flagged')
            : t('list.filter.done'),
      items: [
        {
          kind: 'radio',
          id: 'flagged',
          label: t('emailList.filter.flagged'),
          checked: flagMark === 'flagged',
          count: counts.flagged,
          shortcut: '⌥⌘O',
          onSelect: () => toggleFlagMark('flagged')
        },
        {
          kind: 'radio',
          id: 'done',
          label: t('list.filter.done'),
          checked: flagMark === 'done',
          count: counts.done,
          onSelect: () => toggleFlagMark('done')
        }
      ]
    },
    {
      kind: 'checkbox',
      id: 'toMe',
      label: t('list.filter.toMe'),
      checked: toMe,
      count: userEmail === null ? undefined : counts.toMe,
      disabled: userEmail === null,
      onToggle: () => toggleBool('toMe')
    },
    {
      kind: 'checkbox',
      id: 'hasAttach',
      label: t('list.filter.hasAttach'),
      checked: hasAttach,
      count: counts.hasAttach,
      shortcut: '⇧⌘A',
      onToggle: () => toggleBool('hasAttach')
    },
    {
      kind: 'submenu',
      id: 'priority',
      label: t('list.filter.priority'),
      hint: priCount === ALL_PRIORITIES.length ? undefined : `${priCount}/${ALL_PRIORITIES.length}`,
      items: [
        {
          kind: 'action',
          id: 'pri-all',
          label:
            priCount === ALL_PRIORITIES.length
              ? t('list.filter.clearLink')
              : t('list.filter.selectAll'),
          // 全选/清空是「在这一层继续操作」的行，不该像普通动作那样关掉菜单。
          keepOpen: true,
          onSelect: () =>
            setPriorities(priCount === ALL_PRIORITIES.length ? new Set() : new Set(ALL_PRIORITIES))
        },
        { kind: 'separator', id: 'pri-sep' },
        ...ALL_PRIORITIES.map(
          (p): PopmenuItem => ({
            kind: 'checkbox',
            id: `pri-${p}`,
            label: t(`list.priority.${p}`),
            checked: selectedPriorities.has(p),
            count: priorityCounts[p],
            dotClassName: PRIORITY_DOT_CLASS[p],
            onToggle: () => togglePriority(p)
          })
        )
      ]
    },
    {
      kind: 'submenu',
      id: 'category',
      label: t('list.filter.category'),
      hint: catCount === ALL_CATEGORIES.length ? undefined : `${catCount}/${ALL_CATEGORIES.length}`,
      items: [
        {
          kind: 'action',
          id: 'cat-all',
          label:
            catCount === ALL_CATEGORIES.length
              ? t('list.filter.clearLink')
              : t('list.filter.selectAll'),
          keepOpen: true,
          onSelect: () =>
            setCategories(catCount === ALL_CATEGORIES.length ? new Set() : new Set(ALL_CATEGORIES))
        },
        { kind: 'separator', id: 'cat-sep' },
        // LLM CATEGORY_ENUM is emoji-prefixed Chinese; we render the verbatim
        // string so the menu matches what the backend stores.
        ...ALL_CATEGORIES.map(
          (c): PopmenuItem => ({
            kind: 'checkbox',
            id: `cat-${c}`,
            label: c,
            checked: selectedCategories.has(c),
            count: categoryCounts[c],
            onToggle: () => toggleCategory(c)
          })
        )
      ]
    },
    {
      kind: 'checkbox',
      id: 'failed',
      label: t('emailList.filter.failed'),
      checked: failed,
      count: counts.failed,
      onToggle: () => toggleBool('failed')
    },
    { kind: 'separator', id: 'sep-sort' },
    { kind: 'label', id: 'sort-head', label: t('list.sort.title') },
    ...EMAIL_SORT_KEYS.map(
      (k): PopmenuItem => ({
        kind: 'radio',
        id: `sort-${k}`,
        label: t(`list.sort.key.${k}`),
        checked: sortKey === k,
        onSelect: () => setSort(k)
      })
    ),
    { kind: 'separator', id: 'sep-dir' },
    { kind: 'label', id: 'dir-head', label: t('list.sort.dirTitle') },
    {
      kind: 'radio',
      id: 'dir-desc',
      label: t(DIR_LABEL_KEY[sortKey].desc),
      checked: sortDir === 'desc',
      onSelect: () => setSortDir('desc')
    },
    {
      kind: 'radio',
      id: 'dir-asc',
      label: t(DIR_LABEL_KEY[sortKey].asc),
      checked: sortDir === 'asc',
      onSelect: () => setSortDir('asc')
    },
    // 「清除筛选」只在真有筛选时出现 —— 恒亮的清除钮既没用又占一行。
    ...(filterActive
      ? ([
          { kind: 'separator', id: 'sep-reset' },
          {
            kind: 'action',
            id: 'reset',
            label: t('list.filter.reset'),
            tone: 'accent',
            onSelect: () => resetAll()
          }
        ] as PopmenuItem[])
      : [])
  ]

  return (
    /* Header 两行 — ① 文件夹选择器 · pin 图标 · 写邮件 CTA ② 分栏 + 统计 · 批量 + 筛选 */
    /* 分割线统一 hairline — 与 sidebar header / 各页页头同色连贯。 */
    <div className="relative px-3 pt-2.5 pb-2 border-b [border-bottom-color:var(--hairline)]">
      {/* ── 第一行 ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1">
        <button
          ref={folderTriggerRef}
          type="button"
          className={cn(
            'flex items-center gap-1.5 min-w-0 h-7 pl-1.5 pr-2 rounded-[var(--r-ctl)]',
            'text-ink-fg hover:bg-ink-3 transition-colors duration-fast'
          )}
          title={currentTitle}
          aria-expanded={folderOpen}
          onClick={() => {
            setFolderOpen((o) => !o)
            setFilterOpen(false)
          }}
        >
          {currentIcon}
          <span className="truncate text-aux font-semibold">{currentLabel}</span>
          <ChevronDown size={13} strokeWidth={2} className="shrink-0 text-ink-fg-2" />
          <span className="sr-only">{t('list.folder.trigger')}</span>
        </button>
        <div className="flex-1" />
        {pinChips.map((chip) => {
          // 有未读时可及名补一句 —— chip 只有图标，红点对读屏是不可见的。
          const chipName = chip.unread
            ? t('list.folder.pinUnread', { name: chip.label })
            : chip.label
          return (
            <button
              key={pinnedFolderKey(chip.pin)}
              type="button"
              onClick={chip.onClick}
              title={chipName}
              aria-label={chipName}
              aria-current={chip.active ? 'true' : undefined}
              className={cn(
                'relative shrink-0 w-7 h-7 rounded-[var(--r-ctl)] flex items-center justify-center',
                'transition-colors duration-fast',
                chip.active
                  ? 'text-coral bg-coral/10'
                  : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3'
              )}
            >
              {chip.icon}
              {chip.unread && (
                // 未读点 —— 6px accent 圆点，与 rail 的 `.railbadge[data-shape=dot]` 和列表
                // 行的未读点同一套 token 与尺寸（不显数字：chip 只有 28px，数字在下拉与
                // peek 浮窗里已经有了）。2px 底色描边把它从图标笔画里切出来，同 rail。
                <span
                  data-pin-unread-dot
                  aria-hidden="true"
                  className="absolute top-[3px] right-[3px] w-1.5 h-1.5 rounded-full bg-coral/100"
                  style={{ boxShadow: '0 0 0 2px rgb(var(--ink-0) / 0.6)' }}
                />
              )}
            </button>
          )
        })}
        {pinChips.length > 0 && (
          <span className="shrink-0 w-px h-4 mx-0.5 bg-ink-border" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => openNewCompose()}
          className="list-cta shrink-0 h-7 flex items-center gap-1.5 px-2.5 rounded-[var(--r-ctl)] text-aux font-medium transition-[filter] duration-fast"
          aria-label={t('nav.composeNew')}
        >
          <SquarePenIcon size={13} strokeWidth={2} className="shrink-0" />
          <span>{t('nav.composeNew')}</span>
        </button>
      </div>

      {/* ── 第二行 —— 🔴 行高由右端 28px 工具钮定，与有没有分栏无关（切文件夹不跳）─ */}
      <div className="mt-2 flex items-center gap-2.5">
        {isInboxView && (
          <div
            ref={tabListRef}
            className="inbox-tabs shrink-0"
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
        )}
        <div className="flex items-center gap-1.5 min-w-0 text-meta font-mono text-ink-fg-2">
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
                className="shrink-0 text-coral hover:text-coral-hover transition-colors duration-fast"
                onClick={() => resetAll()}
              >
                {t('list.filter.reset')}
              </button>
            </>
          )}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          className={
            // 主题 v3 C8/批 4: 工具钮档 rounded-md(6) → token 化 --r-ctl
            batchMode === 'on'
              ? 'shrink-0 w-7 h-7 rounded-[var(--r-ctl)] text-coral bg-coral/10 flex items-center justify-center transition-colors duration-fast'
              : 'shrink-0 w-7 h-7 rounded-[var(--r-ctl)] text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 flex items-center justify-center transition-colors duration-fast'
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
          className="filter-btn shrink-0 w-7 h-7 rounded-[var(--r-ctl)] text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 flex items-center justify-center transition-colors duration-fast"
          title={t('list.filter.button')}
          aria-label={t('list.filter.button')}
          aria-haspopup="menu"
          aria-expanded={filterOpen}
          aria-controls="filter-pop"
          data-active={filterActive ? 'true' : 'false'}
          onClick={() => {
            setFilterOpen((o) => !o)
            setFolderOpen(false)
          }}
        >
          <Filter size={13} strokeWidth={2} />
        </button>
      </div>

      <FolderMenu
        open={folderOpen}
        onClose={() => setFolderOpen(false)}
        anchorRef={folderTriggerRef}
        tree={tree}
        onSelectView={selectView}
        onSelectFolder={selectFolder}
        onPinRejected={notifyPinLimit}
      />

      <Popmenu
        id="filter-pop"
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        items={items}
        ariaLabel={t('list.filter.button')}
        triggerRef={filterTriggerRef}
        anchorClassName="right-2 top-[calc(100%+0.375rem)]"
        // 筛选 7 行 + 排序 4 行 + 方向 2 行 ≈ 580px，比基座默认的 288 高一截。
        // 抬上限让常规窗口下一屏看全（Popmenu 仍按视口可用空间二次夹取，窗口矮
        // 时退化成面板内滚动，不会把行推到看不见的地方）。
        maxHeight={640}
      />
    </div>
  )
}
