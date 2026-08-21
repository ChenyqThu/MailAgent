// 通讯录双栏工作台（task 08-13 WP2）。骨架照 MattersWorkspace：列表列 280–560
// 可拖宽（localStorage 持久化 + 拖拽中只写 CSS 变量零 re-render）+ 详情列
// minmax(430px,1fr)；断点 **860px**（设计实测值，两处一致：grid 的
// `max-[860px]:grid-cols-1` 与 WORKSPACE_STACKED_QUERY —— 镜像不猜数）；单列态
// 折叠用 `hidden`（display:none 保滚动位）。flag off 路由直达 = 404 空态
// （主 session 裁决项 1：设计 §7 明文，压过 matters 的 return null 先例）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { UsersRound } from 'lucide-react'

import type { ContactSort, ContactView } from '@shared/api/types/contact'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { useMediaQuery } from '@shared/hooks/useMediaQuery'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { openNewCompose } from '@shared/state/compose-new'
import { toastError, toastSuccess } from '@shared/state/toast'

import { ContactAgentDrawer } from './ContactAgentDrawer'
import { ContactDetail } from './ContactDetail'
import { ContactListPane } from './ContactListPane'
import { readLastContactVisit, writeLastContactVisit } from './contactLastVisit'
import { MergeContactsDialog } from './MergeContactsDialog'
import type { ContactGovernanceTarget, ContactRowActions } from './ContactRow'
import {
  buildContactRows,
  isGroupCollapsed,
  orderedContactIds,
  type ContactDensity,
  type ContactGroupBy,
  type ContactKindBucket
} from './contactListModel'
import {
  useBackfillProgress,
  useContactAgentStatus,
  useContactFlags,
  useContactListPaged,
  useContactsApi,
  useInvalidateContact
} from './hooks'
import { useContactKeyboardNav } from './useContactKeyboardNav'
import { useContactNavigation } from './navigation'

const CONTACT_LIST_WIDTH_STORAGE_KEY = 'mailagent.contacts.listWidth'
const MIN_CONTACT_LIST_WIDTH = 280
const MAX_CONTACT_LIST_WIDTH = 560
const DEFAULT_CONTACT_LIST_WIDTH = 320
const CONTACT_LIST_WIDTH_STEP = 16
// 🔴 镜像下方 grid 的 `max-[860px]:grid-cols-1` 断点（设计实测值：列表最小 280 +
// 详情最小 430 + 收起态导航 52 才放得下双栏）。学 MattersWorkspace 的注释纪律：
// 用同一个数字的两份拷贝必须互相指认，漂了两处会各说各话。
const WORKSPACE_STACKED_QUERY = '(max-width: 860px)'
const SEARCH_DEBOUNCE_MS = 250

function clampListWidth(width: number): number {
  return Math.min(MAX_CONTACT_LIST_WIDTH, Math.max(MIN_CONTACT_LIST_WIDTH, width))
}

function readListWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_CONTACT_LIST_WIDTH
    const raw = localStorage.getItem(CONTACT_LIST_WIDTH_STORAGE_KEY)
    if (raw === null) return DEFAULT_CONTACT_LIST_WIDTH
    const persisted = Number(raw)
    return Number.isFinite(persisted) ? clampListWidth(persisted) : DEFAULT_CONTACT_LIST_WIDTH
  } catch {
    return DEFAULT_CONTACT_LIST_WIDTH
  }
}

function writeListWidth(width: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(CONTACT_LIST_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // localStorage 不可用 —— 本 session 内拖宽仍生效。
  }
}

export function ContactsWorkspace(): React.ReactElement | null {
  const { t } = useTranslation()
  const { contactsEnabled: enabled, contactAgentEnabled, loading } = useContactFlags()
  const api = useContactsApi()
  const invalidate = useInvalidateContact()

  // v2 任务 ③「记住上次离开的位置」：视图必须在 mount 时就恢复（用 useState 初值而不是
  // effect），否则会先按默认视图拉一次列表、再切过去拉第二次 —— 冷启动多一次请求 + 一次跳版。
  const [view, setView] = useState<ContactView>(() => readLastContactVisit()?.view ?? 'known')
  const [sort, setSort] = useState<ContactSort>('density')
  const [groupBy, setGroupBy] = useState<ContactGroupBy>('none')
  const [density, setDensity] = useState<ContactDensity>('compact')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [kindFilter, setKindFilter] = useState<ReadonlySet<ContactKindBucket>>(
    () => new Set<ContactKindBucket>(['person', 'robot', 'list', 'hidden'])
  )
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<number>>(() => new Set())
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)
  const [listWidth, setListWidth] = useState(readListWidth)
  /** WP3 合并入口状态：入口 ①（详情页发起，sourceId）或入口 ②（多选恰 2 条，pair）。
   *  WP7 的 merge 类建议采纳复用入口 ②（服务端只交回 id 对，合并仍走这条唯一人工路径）。 */
  const [mergeState, setMergeState] = useState<
    { sourceId: number; pair: null } | { sourceId: null; pair: [number, number] } | null
  >(null)
  const [agentOpen, setAgentOpen] = useState(false)

  const stacked = useMediaQuery(WORKSPACE_STACKED_QUERY)
  const workspaceGridRef = useRef<HTMLDivElement>(null)
  const resizeDragRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    currentWidth: number
    previousCursor: string
    previousUserSelect: string
  } | null>(null)

  // 搜索防抖 → 服务端 q（主 session 裁决项 6：搜索走服务端 LIKE，即输即搜）。
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [qInput])

  const list = useContactListPaged({ view, q, sort, enabled })
  const items = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.items), [list.data])
  // 服务端报的全量命中数（分页后 items.length 只是「已加载」）。
  const matchedCount = list.data?.pages[0]?.total ?? 0
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list
  const loadMore = useCallback((): void => {
    if (!hasNextPage || isFetchingNextPage) return
    void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])
  const progress = useBackfillProgress(enabled)
  // 🔴 治理 flag 关 → `enabled:false`：不发请求、不起 60s 轮询，胶囊也不进 DOM
  // （两层门，`AgentPendingBadge.tsx:70-79` 先例）。
  const agentStatus = useContactAgentStatus(enabled && contactAgentEnabled)

  const rows = useMemo(
    () =>
      buildContactRows({
        items,
        view,
        groupBy,
        kindFilter,
        collapsed: collapsedGroups,
        labels: {
          kindGroup: (bucket) => t(`contacts.group.${bucket}`),
          fn: (value) => t(`contacts.fn.${value}`),
          level: (value) => t(`contacts.level.${value}`),
          // 「我」恒置顶单独一组（WP-3）。
          self: t('contacts.group.self'),
          // 按汇报线（WP5）：组 label 用行上的 manager_display_name 插值；无名
          // 上级照原型 `m.name || m.id` 用 id 兜底。ungrouped 通道该档特判成
          // 「未设上级」（`contacts.group.noManager`），天然置底。
          manager: (item) =>
            t('contacts.group.reportsOf', {
              name: item.manager_display_name ?? String(item.manager_contact_id)
            }),
          ungrouped:
            groupBy === 'manager' ? t('contacts.group.noManager') : t('contacts.groupBy.ungrouped')
        }
      }),
    [collapsedGroups, groupBy, items, kindFilter, t, view]
  )
  const orderedIds = useMemo(() => orderedContactIds(rows), [rows])
  // 头部计数 = 当前视图**实际列出**的人数（原型 `clist.jsx` 的 `total` 同口径）。
  // 用 `items.length` 会在「全部」视图关掉 chips 时报出一个列表里根本不存在的数。
  const visibleCount = orderedIds.length
  // 🔴 分页之后 `visibleCount` 只覆盖**已加载**的行 ——「通讯录 616」会缩成「通讯录 200」。
  // 判据就一句：本地管线有没有把已加载的行藏起来（chips 关掉 / 分组折叠）。
  //   · 藏了 → 报实际列出的数（= 上面那条老语义，一字不变）
  //   · 没藏 → 报服务端的全量命中数（全部加载完时两者恒相等）
  const headerCount = visibleCount < items.length ? visibleCount : matchedCount

  // v2 任务 ③：选中一个真实联系人时把「id + 当时的视图」写进记录；取消选中
  // （`id === null`）**不清记录** —— 记录留着，下次冷启动按「当前视图的可见集里找不找得到」
  // 重新判定，找不到自然退化成选第一条（照 MattersWorkspace 的同一条纪律）。
  const selectContact = useCallback(
    (id: number | null): void => {
      setSelectedId(id)
      if (id !== null) writeLastContactVisit({ id, view })
    },
    [view]
  )
  useContactKeyboardNav(orderedIds, selectedId, selectContact)

  // WP4 人物页直达通道（PersonChip / ⌘K「人」组 → useContactNavigation.open(id) →
  // navigate('/contacts') → 这里消费即清）。🔴 有意不等列表包含该行（对比
  // MattersWorkspace 的 `allMatters.some(...)` 闸）：detail 按 id 独立拉
  // （GET /contacts/{id}），hidden/robot 的人物页也要能打开，而它们在 known
  // 视图的列表里根本不存在。
  const navigationTarget = useContactNavigation((state) => state.targetContactId)
  const clearNavigationTarget = useContactNavigation((state) => state.clear)
  useEffect(() => {
    if (navigationTarget === null) return
    setSelectedId(navigationTarget)
    clearNavigationTarget()
  }, [clearNavigationTarget, navigationTarget])

  // v2 任务 ③ 冷启动初选：列表第一次落定时恢复上次那个人；记录缺失或那个人已经不在可见集里
  // （被合并 / 被隐藏 / 改判成机器人）→ 退化成选列表第一个。只跑一次（`initialSelectionApplied`
  // 守卫），之后用户的每一次选中都由 `selectContact` 负责。
  // 🔴 深链（⌘K / PersonChip）压过冷启动初选：那条 intent 已经点名了要看谁。
  // 🔴 判据用 `orderedIds` 而不是 `items` —— 前者才是**实际列出**的行（过了 chips 与分组
  // 折叠），恢复出一个用户在列表里看不见的选中等于把详情页钉在一个找不到的人身上。
  const [initialSelectionApplied, setInitialSelectionApplied] = useState(false)
  useEffect(() => {
    if (initialSelectionApplied || !list.isSuccess) return
    setInitialSelectionApplied(true)
    if (navigationTarget !== null) return
    // 🔴 这里走 `setSelectedId` 而不是 `selectContact`：恢复与退化都**不是用户的选择**，
    // 不该回写记录。尤其退化那条 —— 把「列表恰好第一行」写成用户的上次位置，会把一条还
    // 可能有用的记录（那个人只是暂时不在这个视图里）永久覆盖掉。
    const stored = readLastContactVisit()
    if (stored !== null && orderedIds.includes(stored.id)) {
      setSelectedId(stored.id)
      return
    }
    const first = orderedIds[0]
    if (first !== undefined) setSelectedId(first)
  }, [initialSelectionApplied, list.isSuccess, navigationTarget, orderedIds])

  // ── 治理写面（行菜单与档案头共用同一套 handler + toast + 失效）──────────────
  const hideMutation = useMutation({
    mutationFn: (input: { id: number; hidden: boolean; name: string }) =>
      api.hide(input.id, input.hidden),
    onSuccess: async (_result, input) => {
      await invalidate(input.id)
      toastSuccess(
        input.hidden
          ? t('contacts.toast.hidden', { name: input.name })
          : t('contacts.toast.unhidden')
      )
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })
  const kindMutation = useMutation({
    mutationFn: (input: { id: number; kind: 'person' | 'robot' | 'list' }) =>
      api.setKind(input.id, input.kind),
    onSuccess: async (_result, input) => {
      await invalidate(input.id)
      toastSuccess(t('contacts.toast.kind', { kind: t(`contacts.kind.${input.kind}`) }))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })
  const selfMutation = useMutation({
    mutationFn: (input: { id: number; isSelf: boolean }) => api.setSelf(input.id, input.isSelf),
    onSuccess: async (_result, input) => {
      await invalidate(input.id)
      toastSuccess(t(input.isSelf ? 'contacts.toast.markSelf' : 'contacts.toast.unmarkSelf'))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })

  const enterSelection = useCallback((item: ContactGovernanceTarget): void => {
    setSelectionMode(true)
    setCheckedIds((previous) => {
      const next = new Set(previous)
      next.add(item.id)
      return next
    })
  }, [])
  const toggleCheck = useCallback((item: ContactGovernanceTarget): void => {
    setCheckedIds((previous) => {
      const next = new Set(previous)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }, [])
  const exitSelection = useCallback((): void => {
    setSelectionMode(false)
    setCheckedIds(new Set())
  }, [])

  const actions: ContactRowActions = useMemo(
    () => ({
      onOpen: (item) => selectContact(item.id),
      onCompose: (item) => {
        openNewCompose(item.primary_email ?? undefined)
        if (item.primary_email) {
          toastSuccess(t('contacts.toast.composePrefill', { email: item.primary_email }))
        }
      },
      // WP5「写邮件并抄送上级」：收件人 = TA、抄送 = TA 的上级。列表行只带上级
      // id（裁决 5），主邮箱点击时按 id 取详情解析；取不到（异常兜底）降级为
      // 仅预填收件人。
      onComposeCc: (item, managerContactId) => {
        void (async () => {
          let managerEmail: string | undefined
          try {
            const managerDetail = await api.get(managerContactId)
            managerEmail =
              managerDetail.emails.find((email) => email.is_primary)?.address ??
              managerDetail.emails[0]?.address ??
              undefined
          } catch {
            managerEmail = undefined
          }
          openNewCompose(item.primary_email ?? undefined, managerEmail ? [managerEmail] : undefined)
          if (item.primary_email) {
            toastSuccess(t('contacts.toast.composePrefill', { email: item.primary_email }))
          }
        })()
      },
      onSetKind: (item, kind) => kindMutation.mutate({ id: item.id, kind }),
      onToggleSelf: (item) => selfMutation.mutate({ id: item.id, isSelf: !item.is_self }),
      onToggleHidden: (item) =>
        hideMutation.mutate({
          id: item.id,
          hidden: item.hidden_at == null,
          name: item.display_name ?? item.primary_email ?? ''
        }),
      onEnterSelection: enterSelection,
      onToggleCheck: toggleCheck
    }),
    [api, enterSelection, hideMutation, kindMutation, selectContact, selfMutation, t, toggleCheck]
  )

  const finishListResize = useCallback((target: HTMLDivElement, pointerId: number): void => {
    const drag = resizeDragRef.current
    if (!drag || drag.pointerId !== pointerId) return
    resizeDragRef.current = null
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    document.body.style.cursor = drag.previousCursor
    document.body.style.userSelect = drag.previousUserSelect
    setListWidth(drag.currentWidth)
    writeListWidth(drag.currentWidth)
  }, [])

  useEffect(
    () => () => {
      const drag = resizeDragRef.current
      if (!drag) return
      document.body.style.cursor = drag.previousCursor
      document.body.style.userSelect = drag.previousUserSelect
    },
    []
  )

  // flags query 加载中渲染 null；确认 off 后 = 404 空态（裁决项 1）。
  if (loading) return null
  if (!enabled) {
    return (
      <EmptyState
        fill
        icon={<UsersRound size={22} strokeWidth={1.5} />}
        title={t('contacts.disabled.title')}
        hint={t('contacts.disabled.hint')}
      />
    )
  }

  return (
    <div
      ref={workspaceGridRef}
      className="grid h-full min-h-0 grid-cols-[var(--contact-list-width)_6px_minmax(430px,1fr)] max-[860px]:grid-cols-1"
      style={{ '--contact-list-width': `${listWidth}px` } as React.CSSProperties}
    >
      <div className={cn('min-h-0', selectedId !== null && 'max-[860px]:hidden')}>
        <ContactListPane
          view={view}
          onViewChange={(next) => {
            setView(next)
            selectContact(null)
          }}
          q={qInput}
          onQChange={setQInput}
          sort={sort}
          onSortChange={setSort}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          density={density}
          onDensityChange={setDensity}
          kindFilter={kindFilter}
          onKindFilterToggle={(bucket) =>
            setKindFilter((previous) => {
              const next = new Set(previous)
              if (next.has(bucket)) next.delete(bucket)
              else next.add(bucket)
              return next
            })
          }
          rows={rows}
          total={headerCount}
          loading={list.isPending}
          onLoadMore={loadMore}
          hasMore={hasNextPage}
          progress={progress.data}
          selectedId={selectedId}
          selectionMode={selectionMode}
          checkedIds={checkedIds}
          onExitSelection={exitSelection}
          onMergePair={(pair) => setMergeState({ sourceId: null, pair })}
          menuOpenId={menuOpenId}
          onMenuOpenChange={setMenuOpenId}
          onToggleGroup={(groupKey) =>
            setCollapsedGroups((previous) => ({
              ...previous,
              [groupKey]: !isGroupCollapsed(previous, groupKey)
            }))
          }
          actions={actions}
          agentEnabled={contactAgentEnabled}
          pendingCount={agentStatus.data?.pending_count ?? 0}
          onOpenAgent={() => setAgentOpen(true)}
        />
      </div>
      <div
        role="separator"
        aria-label={t('contacts.list.resize')}
        aria-orientation="vertical"
        aria-valuemin={MIN_CONTACT_LIST_WIDTH}
        aria-valuemax={MAX_CONTACT_LIST_WIDTH}
        aria-valuenow={listWidth}
        tabIndex={0}
        className="group relative z-10 cursor-col-resize touch-none outline-none max-[860px]:hidden"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          resizeDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: listWidth,
            currentWidth: listWidth,
            previousCursor: document.body.style.cursor,
            previousUserSelect: document.body.style.userSelect
          }
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
        }}
        onPointerMove={(event) => {
          const drag = resizeDragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          const nextWidth = clampListWidth(drag.startWidth + event.clientX - drag.startX)
          drag.currentWidth = nextWidth
          // 🔴 拖拽中只写 CSS 变量不 setState（零 re-render 手法，照 MattersWorkspace）。
          workspaceGridRef.current?.style.setProperty('--contact-list-width', `${nextWidth}px`)
        }}
        onPointerUp={(event) => finishListResize(event.currentTarget, event.pointerId)}
        onPointerCancel={(event) => finishListResize(event.currentTarget, event.pointerId)}
        onLostPointerCapture={(event) => finishListResize(event.currentTarget, event.pointerId)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const delta =
            event.key === 'ArrowLeft' ? -CONTACT_LIST_WIDTH_STEP : CONTACT_LIST_WIDTH_STEP
          const nextWidth = clampListWidth(listWidth + delta)
          workspaceGridRef.current?.style.setProperty('--contact-list-width', `${nextWidth}px`)
          setListWidth(nextWidth)
          writeListWidth(nextWidth)
        }}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-border transition-colors group-hover:bg-coral/70 group-focus-visible:bg-coral/70" />
      </div>
      <div className={cn('min-h-0', selectedId === null && 'max-[860px]:hidden')}>
        {selectedId !== null ? (
          <ContactDetail
            contactId={selectedId}
            onBack={() => selectContact(null)}
            actions={actions}
            showBack={stacked}
            onMergeRequest={() => setMergeState({ sourceId: selectedId, pair: null })}
          />
        ) : (
          <EmptyState
            fill
            icon={<UsersRound size={20} strokeWidth={1.5} />}
            title={t('contacts.empty.detail')}
          />
        )}
      </div>
      <MergeContactsDialog
        open={mergeState !== null}
        onOpenChange={(next) => {
          if (!next) setMergeState(null)
        }}
        sourceId={mergeState?.sourceId ?? null}
        pairIds={mergeState?.pair ?? null}
        onMerged={(winnerId) => {
          // 成功：列表/详情切到保留方 + 退出多选（失效在 dialog 内做完）。
          setMergeState(null)
          exitSelection()
          selectContact(winnerId)
        }}
      />
      {/* WP7 治理台。🔴 flag 关 → 连组件都不挂载（内部三条查询字节级不发）。 */}
      {contactAgentEnabled ? (
        <ContactAgentDrawer
          open={agentOpen}
          onOpenChange={setAgentOpen}
          onOpenPerson={selectContact}
          onMergePair={(pair) => setMergeState({ sourceId: null, pair })}
        />
      ) : null}
    </div>
  )
}
