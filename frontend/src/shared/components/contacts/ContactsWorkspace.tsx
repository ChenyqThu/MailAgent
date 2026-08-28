// 通讯录双栏工作台（task 08-13 WP2）。列表列定宽 336px（task 08-27 P1 Lane C 续改：
// 拖拽调宽体系退役，二级栏恒 336，切域时左列边界不动）+ 详情列 minmax(430px,1fr)；
// 断点 **860px**（设计实测值，两处一致：grid 的 `max-[860px]:grid-cols-1` 与
// WORKSPACE_STACKED_QUERY —— 镜像不猜数）；单列态折叠用 `hidden`（display:none 保滚动位）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { UsersRound } from 'lucide-react'

import type { ContactSort, ContactView } from '@shared/api/types/contact'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { useMediaQuery } from '@shared/hooks/useMediaQuery'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { openNewCompose } from '@shared/state/compose-new'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'
import { useNavCollapsed } from '@shared/state/nav-shell'
import { toastError, toastSuccess } from '@shared/state/toast'

import { ContactAgentDrawer } from './ContactAgentDrawer'
import { ContactDetail } from './ContactDetail'
import { ContactListPane } from './ContactListPane'
import { readLastContactVisit, writeLastContactVisit } from './contactLastVisit'
import { readContactListPrefs, writeContactListPrefs } from './contactListPrefs'
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
  useContactListPaged,
  useContactsApi,
  useInvalidateContact
} from './hooks'
import { useContactKeyboardNav } from './useContactKeyboardNav'
import { useContactNavigation } from './navigation'

// 🔴 镜像下方 grid 的 `max-[860px]:grid-cols-1` 断点（设计实测值：列表最小 336 +
// 详情最小 430 + 收起态导航 52 才放得下双栏）。学 MattersWorkspace 的注释纪律：
// 用同一个数字的两份拷贝必须互相指认，漂了两处会各说各话。
const WORKSPACE_STACKED_QUERY = '(max-width: 860px)'
/** 双栏骨架（config 加载中）与真实布局共用同一份 grid 类，几何不对就是白闪一下再跳版。
 *  task 08-27 P1 Lane C 续改：清单列定宽 336px（左列总宽 392 = 导轨 56 + 二级栏 336）。 */
const WORKSPACE_GRID_CLASS =
  'grid h-full min-h-0 grid-cols-[336px_minmax(430px,1fr)] max-[860px]:grid-cols-1'
/** 0825 轮 3 —— 清单列被 nav shell 折叠收起时的单列变体（列表 display:none 不参与轨道）。 */
const WORKSPACE_GRID_CLASS_COLLAPSED = 'grid h-full min-h-0 grid-cols-[minmax(430px,1fr)]'

export function ContactsWorkspace(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useContactsApi()
  const invalidate = useInvalidateContact()

  // v2 任务 ③「记住上次离开的位置」：视图必须在 mount 时就恢复（用 useState 初值而不是
  // effect），否则会先按默认视图拉一次列表、再切过去拉第二次 —— 冷启动多一次请求 + 一次跳版。
  const [view, setView] = useState<ContactView>(() => readLastContactVisit()?.view ?? 'known')
  // 排序 / 分组 / 密度同样在 mount 时就恢复（task 08-20 P3-10）：`sort` 进列表的 queryKey，
  // 复位成默认档 = 另一个 key = 改过排序再回来必定冷取 + 骨架。三档一起持久化，写回见
  // 下面三个 setter（state 是运行时权威，localStorage 只是 seed —— 同 contactLastVisit）。
  const [prefs, setPrefs] = useState(readContactListPrefs)
  const { sort, groupBy, density } = prefs
  const [q, setQ] = useState('')
  const [kindFilter, setKindFilter] = useState<ReadonlySet<ContactKindBucket>>(
    () => new Set<ContactKindBucket>(['person', 'robot', 'list', 'hidden'])
  )
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  // 🔴 冷启动初值就带上「上次选中的人」（task 08-20 P0-3）：老写法初值恒 null、等列表回来的
  // effect 才产生 selectedId ⇒ 详情排在列表**后面**发（首屏 4 跳里的第 3 跳）。深链
  // （⌘K / PersonChip）比记录更明确，优先用它 —— 否则会先按记录拉一份马上被顶掉的详情。
  // 列表回来后仍要对账：那个人可能已被合并 / 隐藏 / 改判（见下方初选 effect）。
  const [selectedId, setSelectedId] = useState<number | null>(
    () => useContactNavigation.getState().targetContactId ?? readLastContactVisit()?.id ?? null
  )
  const [selectionMode, setSelectionMode] = useState(false)
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<number>>(() => new Set())
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)
  /** WP3 合并入口状态：入口 ①（详情页发起，sourceId）或入口 ②（多选恰 2 条，pair）。
   *  WP7 的 merge 类建议采纳复用入口 ②（服务端只交回 id 对，合并仍走这条唯一人工路径）。 */
  const [mergeState, setMergeState] = useState<
    { sourceId: number; pair: null } | { sourceId: null; pair: [number, number] } | null
  >(null)
  const [agentOpen, setAgentOpen] = useState(false)

  const stacked = useMediaQuery(WORKSPACE_STACKED_QUERY)
  // 0825 轮 3 —— 清单列 = 通讯录域的「二级栏」（registry second:'page'），收起走 nav shell
  // 的同一个折叠状态；排除 forced 的理由同 MattersWorkspace（窄窗由 max-[860px] 自治）。
  const listPanelHidden = useNavCollapsed((s) => s.collapsed && !s.forced)

  // 三个显示档位的写回：state 变了就落盘一次（写在 effect 里而不是 setter 里 —— state
  // updater 必须是纯函数，StrictMode 下会被调用两次）。
  useEffect(() => {
    writeContactListPrefs(prefs)
  }, [prefs])
  const setSort = useCallback(
    (next: ContactSort) => setPrefs((previous) => ({ ...previous, sort: next })),
    []
  )
  const setGroupBy = useCallback(
    (next: ContactGroupBy) => setPrefs((previous) => ({ ...previous, groupBy: next })),
    []
  )
  const setDensity = useCallback(
    (next: ContactDensity) => setPrefs((previous) => ({ ...previous, density: next })),
    []
  )

  const list = useContactListPaged({ view, q, sort, enabled: true })
  const items = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.items), [list.data])
  // 服务端报的全量命中数（分页后 items.length 只是「已加载」）。
  const matchedCount = list.data?.pages[0]?.total ?? 0
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list
  const loadMore = useCallback((): void => {
    if (!hasNextPage || isFetchingNextPage) return
    void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])
  const progress = useBackfillProgress(true)
  const agentStatus = useContactAgentStatus(true)

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

  // 主标签第二段 = 选中的那个人（design §三）。名字取自**已加载的列表行** —— 深链
  // （⌘K / PersonChip / 通知）可以点名一个当前视图列不出来的人（隐藏 / 机器人 / 还没翻到
  // 那一页），那时取不到名字就退回单段，不为面包屑单独发一次详情查询。P4 通讯录重做时
  // 若详情已在手，改成由详情回填更准。
  const selectedName = useMemo(() => {
    if (selectedId === null) return null
    const row = items.find((item) => item.id === selectedId)
    if (row === undefined) return null
    return row.display_name?.trim() || row.primary_email || null
  }, [items, selectedId])
  useMainBreadcrumb('contacts', selectedName)

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
  // 治理队列直达（通知中心 `contact_queue` link → openQueue() → navigate('/contacts')）。
  // 与人物页直达是同一个 store 的两条独立轴，各清各的。
  const queueRequested = useContactNavigation((state) => state.queueRequested)
  const clearQueueRequest = useContactNavigation((state) => state.clearQueue)
  useEffect(() => {
    if (!queueRequested) return
    setAgentOpen(true)
    clearQueueRequest()
  }, [clearQueueRequest, queueRequested])

  const navigationTarget = useContactNavigation((state) => state.targetContactId)
  const clearNavigationTarget = useContactNavigation((state) => state.clear)
  const [initialSelectionApplied, setInitialSelectionApplied] = useState(false)
  useEffect(() => {
    if (navigationTarget === null) return
    setSelectedId(navigationTarget)
    clearNavigationTarget()
    // 🔴 深链一旦落地就把冷启动初选记成「已经做过」：intent 已经点名了要看谁，而下面那条
    // effect 的守卫读的是 `navigationTarget` —— 这里刚把它清掉，列表晚一步落定时它已是 null，
    // 守卫就拦不住了（会把用户点名的那个人换成记录里的 / 列表第一个）。
    setInitialSelectionApplied(true)
  }, [clearNavigationTarget, navigationTarget])

  // v2 任务 ③ 冷启动初选，现在是**对账**（task 08-20 P0-3 之后）：上次那个人已经在 mount 时
  // 进了 selectedId（见上面的 useState 初值），列表第一次落定时只需确认它还在可见集里；不在
  // （被合并 / 被隐藏 / 改判成机器人）或压根没有记录 → 退化成选列表第一个。只跑一次
  // （`initialSelectionApplied` 守卫），之后用户的每一次选中都由 `selectContact` 负责。
  // 🔴 判据用 `orderedIds` 而不是 `items` —— 前者才是**实际列出**的行（过了 chips 与分组
  // 折叠），留着一个用户在列表里看不见的选中等于把详情页钉在一个找不到的人身上。
  useEffect(() => {
    if (initialSelectionApplied || !list.isSuccess) return
    setInitialSelectionApplied(true)
    if (navigationTarget !== null) return
    // 🔴 这里走 `setSelectedId` 而不是 `selectContact`：保留与退化都**不是用户的选择**，
    // 不该回写记录。尤其退化那条 —— 把「列表恰好第一行」写成用户的上次位置，会把一条还
    // 可能有用的记录（那个人只是暂时不在这个视图里）永久覆盖掉。
    const stored = readLastContactVisit()
    if (stored !== null && orderedIds.includes(stored.id)) return
    setSelectedId(orderedIds[0] ?? null)
  }, [initialSelectionApplied, list.isSuccess, navigationTarget, orderedIds])

  // ── 治理写面（行菜单与档案头共用同一套 handler + toast + 失效）──────────────
  // 🔴 只解构 `mutate`（task 08-20 P1-6）：react-query v5 的 `useMutation` **每次 render 都
  // 返回一个新对象**，把整个返回值放进下面 `actions` 的依赖数组 = 那份 useMemo 永不命中 ⇒
  // `actions` 每次都是新引用 ⇒ 摊进 rowProps 后 react-window 的浅比较全线失效（可见行全量
  // 重渲染）+ 详情页的 memo 恒失效。`mutate` 本身是 v5 保证的稳定引用。
  const { mutate: hideContact } = useMutation({
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
  const { mutate: setContactKind } = useMutation({
    mutationFn: (input: { id: number; kind: 'person' | 'robot' | 'list' }) =>
      api.setKind(input.id, input.kind),
    onSuccess: async (_result, input) => {
      await invalidate(input.id)
      toastSuccess(t('contacts.toast.kind', { kind: t(`contacts.kind.${input.kind}`) }))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })
  const { mutate: setContactSelf } = useMutation({
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
      onSetKind: (item, kind) => setContactKind({ id: item.id, kind }),
      onToggleSelf: (item) => setContactSelf({ id: item.id, isSelf: !item.is_self }),
      onToggleHidden: (item) =>
        hideContact({
          id: item.id,
          hidden: item.hidden_at == null,
          name: item.display_name ?? item.primary_email ?? ''
        }),
      onEnterSelection: enterSelection,
      onToggleCheck: toggleCheck
    }),
    [
      api,
      enterSelection,
      hideContact,
      selectContact,
      setContactKind,
      setContactSelf,
      t,
      toggleCheck
    ]
  )

  // 下面三个回调都必须是稳定引用：`toggleGroup` 会被摊进 rowProps（浅比较），另外两个是
  // memo 过的 `ContactDetail` 的 props（写成内联箭头 = 每次 render 一个新函数 = memo 恒失效）。
  const toggleGroup = useCallback((groupKey: string): void => {
    setCollapsedGroups((previous) => ({
      ...previous,
      [groupKey]: !isGroupCollapsed(previous, groupKey)
    }))
  }, [])
  const backToList = useCallback((): void => selectContact(null), [selectContact])
  const requestMerge = useCallback((): void => {
    if (selectedId !== null) setMergeState({ sourceId: selectedId, pair: null })
  }, [selectedId])

  return (
    <div className={listPanelHidden ? WORKSPACE_GRID_CLASS_COLLAPSED : WORKSPACE_GRID_CLASS}>
      <div
        className={cn(
          'min-h-0 border-r border-ink-border',
          selectedId !== null && 'max-[860px]:hidden',
          listPanelHidden && 'hidden'
        )}
      >
        <ContactListPane
          view={view}
          onViewChange={(next) => {
            setView(next)
            selectContact(null)
          }}
          onSearchChange={setQ}
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
          onToggleGroup={toggleGroup}
          actions={actions}
          agentEnabled
          pendingCount={agentStatus.data?.pending_count ?? 0}
          onOpenAgent={() => setAgentOpen(true)}
        />
      </div>
      <div className={cn('min-h-0', selectedId === null && 'max-[860px]:hidden')}>
        {selectedId !== null ? (
          <ContactDetail
            contactId={selectedId}
            onBack={backToList}
            actions={actions}
            showBack={stacked || listPanelHidden}
            onMergeRequest={requestMerge}
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
      {/* WP7 治理台。恒挂载，内部查询/可见性都由 `open`/`agentOpen` 一处门控。 */}
      <ContactAgentDrawer
        open={agentOpen}
        onOpenChange={setAgentOpen}
        onOpenPerson={selectContact}
        onMergePair={(pair) => setMergeState({ sourceId: null, pair })}
      />
    </div>
  )
}
