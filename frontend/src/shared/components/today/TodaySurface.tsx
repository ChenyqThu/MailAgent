// 「今日」域的主区 —— **五节**（task 08-27 P4c）。
//
// P1-P3 这里是「例外面」：五个**读态组**（等我处理 / 进行中 / 已失效 / 需要留意 /
// 最近结果）+ 一张 `SECTION_TO_GROUP` 过渡映射把二级栏的五节对上去。P4c 把主区换成与
// 二级栏一一对应的五节，那张映射随之删除（它自己的注释预告过）。
//
// 例外面没有被拆掉，是被**装进 decide / due / out 三节里**：`TodayItemRow` 的行内审批卡、
// 派发回答框、信号 triage 菜单一件没动 —— 那是批次 2/3 的全部价值，换成简化行等于返工。
// 节内仍按读态分块（等我处理 / 已失效…），因为「同一条 run 在不同组里色调不同，正是它
// 现在的处境不同」这条语义没有变。
//
// 定位（owner 拍板 D5，未变）：今日页是**回顾面**，不是审批队列 —— 「agent 做了什么 +
// 我可事后改」。北极星是每天需要 owner 亲自做的决定数单调下降。

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Sun } from 'lucide-react'

import { EmptyState } from '@shared/components/feedback/EmptyState'
import { useAttentionAction, useItemDispatchAction } from '@shared/components/matters/hooks'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { navEntry, navigateToNavEntry, navigateToReport } from '@shared/navigation/registry'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'
import { useActiveEmail } from '@shared/state/active-email'
import { useTodaySection, type TodaySectionId } from '@shared/state/today-section'
import { cn } from '@shared/lib/cn'

import { TodayItemRow, type TodayRowHandlers } from './TodayItemRow'
import { TodayNextHardPoint } from './TodayNextHardPoint'
import { TodaySectionRow } from './TodaySectionRow'
import { TodayListSkeleton } from './TodaySkeleton'
import { TodayTimeline } from './TodayTimeline'
import { TODAY_GROUP_ICONS, TODAY_GROUP_TONE, TODAY_TONE_CLASS } from './todayVocab'
import type { TodaySectionItem } from './todaySections'
import { useTodaySections } from './useTodaySections'

export function TodaySurface(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { sections, nextHardPoint, pendingDecisions, isPending, isError, nowMs, refreshRuns } =
    useTodaySections()
  const rootRef = useRef<HTMLDivElement>(null)
  const section = useTodaySection((s) => s.section)
  const sectionNonce = useTodaySection((s) => s.nonce)

  // 二级栏点节 → 滚到那一节。nonce 让再点同一节也重滚。
  useEffect(() => {
    if (sectionNonce === 0) return // 初始态不打扰用户的自然滚动位置。
    const root = rootRef.current
    if (!root) return
    const target = root.querySelector(`[data-section="${section}"]`)
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    else root.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [sectionNonce, section])

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const openMatter = useMatterNavigation((state) => state.open)
  const setActiveEmail = useActiveEmail((s) => s.setActive)
  const attentionAction = useAttentionAction()
  const dispatchAction = useItemDispatchAction()

  const handlers: TodayRowHandlers = {
    onOpenMatter: (publicId) => {
      // 既有 matter deep-link：store intent → 事项工作台挂载时消费（同通知面板的 matter 型）。
      openMatter(publicId)
      void navigate({ to: '/matters' })
    },
    onOpenRecord: (sessionId) => {
      // 既有 run 记录导航：park sessionId → /sessions 的 AgentViewLayout 消费并 select。
      requestOpenAgentSession(sessionId)
      void navigate({ to: '/sessions' })
    },
    onSignalAction: (matterId, signalId, action, reason) => {
      attentionAction.mutate({ matterId, signalId, action, reason })
    },
    // 派发的回答 / 取消走事项域的共享写口（它自己带 refreshMatter，跨事项聚合也一起刷）。
    onDispatchAnswer: (matterId, dispatchId, text) => {
      dispatchAction.mutate({ matterId, dispatchId, action: 'answer', text })
    },
    onDispatchCancel: (matterId, dispatchId) => {
      dispatchAction.mutate({ matterId, dispatchId, action: 'cancel' })
    },
    onToggleExpand: setExpandedId,
    onDecided: refreshRuns
  }

  /** 简化行的落点。三档各自复用**既有**通道，本页不新造导航。 */
  const openSectionItem = (item: TodaySectionItem): void => {
    switch (item.link.kind) {
      case 'mail':
        // 🔴 `{ navTarget: true }`：待回的信按定义大多不在收件箱当前加载窗口里，不豁免
        // 的话 `useEmailListRows` 的 active-reset 会立刻把 active 抢回列表第一封
        // （通讯录那两处证据钮踩过同一个坑）。
        setActiveEmail(item.link.internalId, { navTarget: true })
        void navigate({ to: '/' })
        return
      case 'calendar':
        // 🔴 路径字面量不出 registry —— 日历的真实路由是 `/admin/calendar?view=week`，
        // 侧栏 `match.exact` 里那个 `/calendar` 只是匹配用的别名，直接 navigate 过去
        // 会落到不存在的路由（typecheck 当场红，这条已经踩过）。
        navigateToNavEntry(navigate, navEntry('calendar'))
        return
      case 'report':
        navigateToReport(navigate, item.link.reportId)
        return
    }
  }

  const total = sections.reduce((n, s) => n + s.count, 0)

  return (
    // 宽窗才让出右边那 292 + 22：窄窗下整列隐藏，主区宽度与没有这一列时**一模一样**
    // （880 = 1194 - 292 - 22），所以加这一列不会把已有的主区挤窄。
    <div
      ref={rootRef}
      className="mx-auto w-full max-w-[880px] px-6 py-6 [@media(min-width:1360px)]:max-w-[1194px]"
    >
      <header className="mb-4 flex flex-col gap-[3px]">
        <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
          {t('today.kicker')}
        </div>
        <h1 className="text-subj font-semibold text-ink-fg">{t('today.title')}</h1>
        <p className="text-meta text-ink-fg-3">
          {isPending ? t('today.subtitleLoading') : t('today.subtitle', { count: total })}
        </p>
      </header>

      {/* 整页唯一「现在就看」的一行。没有硬时间点就整条不出现 —— 空占一条比没有更糟。 */}
      <TodayNextHardPoint
        entry={nextHardPoint}
        nowMs={nowMs}
        pendingDecisions={pendingDecisions}
        onOpen={() => navigateToNavEntry(navigate, navEntry('calendar'))}
      />

      {/* 原型 `.today2` —— 主区 flex-1 + 右侧时间线列 292，gap 22。 */}
      <div className="flex items-start gap-[22px]">
        {/* 时间线列把同一批条目的标题 / 副行**再渲染一遍**（同一份数据换一根轴）——
            两列的文案天然重名，断言必须说清问的是哪一列。 */}
        <div data-testid="today-main" className="min-w-0 flex-1">
          {isPending ? (
            <TodayListSkeleton />
          ) : (
            <>
              {/* 事项两条读失败不遮盖已经拿到的条目：报一条横幅，列表照常渲染。 */}
              {isError && (
                <div className="mb-3 rounded-[var(--r-ctl)] border border-warn/30 bg-warn/[0.07] px-3 py-2 text-meta text-ink-fg-2">
                  {t('today.error')}
                </div>
              )}
              {total === 0 ? (
                <EmptyState
                  icon={<Sun size={22} strokeWidth={1.75} />}
                  title={t('today.empty.title')}
                  hint={t('today.empty.hint')}
                  className="min-h-[280px]"
                />
              ) : (
                sections.map((view) =>
                  view.count === 0 ? null : (
                    <section
                      key={view.id}
                      data-testid="today-section"
                      data-section={view.id}
                      className="mb-5"
                    >
                      <SectionHeader
                        id={view.id}
                        count={view.count}
                        selected={section === view.id}
                      />
                      {/* 简化行在前（会 / 待回的信 / 当天报告 —— 这一节的正题），读态组在后。 */}
                      {view.rows.map((item) => (
                        <TodaySectionRow key={item.id} item={item} onOpen={openSectionItem} />
                      ))}
                      {view.groups.map((group) => {
                        const Icon = TODAY_GROUP_ICONS[group.id]
                        const toneClass = TODAY_TONE_CLASS[TODAY_GROUP_TONE[group.id]]
                        return (
                          <div
                            key={group.id}
                            data-testid="today-group"
                            data-group={group.id}
                            data-in-section={view.id}
                          >
                            {/* 节内的读态分块头（比节头轻一档）。只有一个组时不出头 ——
                                「等我处理」下面再写一遍「等我处理」是废话。 */}
                            {view.groups.length > 1 && (
                              <div className="flex items-center gap-2 pb-1 pt-1.5">
                                <span
                                  className={cn(
                                    'grid size-4 shrink-0 place-items-center rounded',
                                    toneClass.icon
                                  )}
                                >
                                  <Icon size={10} strokeWidth={2} />
                                </span>
                                <span className="text-micro text-ink-fg-3">
                                  {t(`today.group.${group.id}`)}
                                </span>
                                <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
                              </div>
                            )}
                            {group.items.map((item) => (
                              <TodayItemRow
                                key={item.id}
                                item={item}
                                groupId={group.id}
                                nowMs={nowMs}
                                expanded={expandedId === item.id}
                                menuOpen={menuOpenId === item.id}
                                onMenuOpenChange={setMenuOpenId}
                                handlers={handlers}
                              />
                            ))}
                          </div>
                        )
                      })}
                    </section>
                  )
                )
              )}
            </>
          )}
        </div>
        {/* 骨架期不出这一列：那时 `sections` 还是空的，画一列「今天没有带时刻的条目」
            是假话（数据还没到，不是真的没有）。 */}
        {!isPending && <TodayTimeline sections={sections} />}
      </div>
    </div>
  )
}

function SectionHeader({
  id,
  count,
  selected
}: {
  id: TodaySectionId
  count: number
  selected: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 pb-1.5">
      {/* 二级栏当前节 → 左侧一根 2px accent 竖条（原型的节标题选中态）。 */}
      {selected && (
        <span
          aria-hidden
          className="h-[14px] w-[2px] shrink-0 rounded-full bg-[rgb(var(--c-accent))]"
        />
      )}
      <span className="text-meta font-medium text-ink-fg-2">{t(`today.nav.${id}`)}</span>
      <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
      <span className="text-micro text-ink-fg-3">{t('today.groupCount', { count })}</span>
    </div>
  )
}
