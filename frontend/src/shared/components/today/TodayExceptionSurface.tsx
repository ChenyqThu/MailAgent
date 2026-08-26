// 「今日」域的第一个页面：**例外面**（L4 批次 2 · WS-B B1）。
//
// 定位（owner 拍板 D5）：例外面 = **回顾面**，不是审批队列 —— 「agent 做了什么 + 我可事后
// 改」。北极星是每天需要 owner 亲自做的决定数单调下降，队列越审越长就说明分级是假的。
//
// 与通知中心的划界（prd §3）：铃铛是**推送侧事件流**（某信源某时刻发生了一件事，状态长在
// 通知行上）；例外面是**拉取侧待处理态**（条目身份 = 源实体，在不在只由源实体读态决定，
// 没有归档动作）。本页因此直接读四条源实体端点，不经 `notification` 表
// （第四条 = 行动项派发，L4 批次 3）。

import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Sun } from 'lucide-react'

import { EmptyState } from '@shared/components/feedback/EmptyState'
import { useAttentionAction, useItemDispatchAction } from '@shared/components/matters/hooks'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'
import { cn } from '@shared/lib/cn'

import { TodayItemRow, type TodayRowHandlers } from './TodayItemRow'
import { TodayListSkeleton } from './TodaySkeleton'
import { TODAY_GROUP_ICONS, TODAY_GROUP_TONE, TODAY_TONE_CLASS } from './todayVocab'
import { useTodayData } from './useTodayData'

export function TodayExceptionSurface(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { groups, isPending, isError, nowMs, refreshRuns } = useTodayData()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const openMatter = useMatterNavigation((state) => state.open)
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

  const total = groups.reduce((n, group) => n + group.items.length, 0)

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-6">
      <header className="mb-5 flex flex-col gap-[3px]">
        <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
          {t('today.kicker')}
        </div>
        <h1 className="text-subj font-semibold text-ink-fg">{t('today.title')}</h1>
        <p className="text-meta text-ink-fg-3">
          {isPending ? t('today.subtitleLoading') : t('today.subtitle', { count: total })}
        </p>
      </header>

      {isPending ? (
        <TodayListSkeleton />
      ) : (
        <>
          {/* 事项两条读失败不遮盖已经拿到的 run 条目：报一条横幅，列表照常渲染。 */}
          {isError && (
            <div className="mb-3 rounded-[var(--r-ctl)] border border-warn/30 bg-warn/[0.07] px-3 py-2 text-meta text-ink-fg-2">
              {t('today.error')}
            </div>
          )}
          {groups.length === 0 ? (
            <EmptyState
              icon={<Sun size={22} strokeWidth={1.75} />}
              title={t('today.empty.title')}
              hint={t('today.empty.hint')}
              className="min-h-[280px]"
            />
          ) : (
            groups.map((group) => {
              const Icon = TODAY_GROUP_ICONS[group.id]
              const toneClass = TODAY_TONE_CLASS[TODAY_GROUP_TONE[group.id]]
              return (
                <section
                  key={group.id}
                  data-testid="today-group"
                  data-group={group.id}
                  className="mb-5"
                >
                  {/* 分组头照 `MatterProgressLane` 的「标签 + 发丝线 + 条数」。 */}
                  <div className="flex items-center gap-2 pb-1.5">
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded-md',
                        toneClass.icon
                      )}
                    >
                      <Icon size={12} strokeWidth={2} />
                    </span>
                    <span className="text-meta font-medium text-ink-fg-2">
                      {t(`today.group.${group.id}`)}
                    </span>
                    <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
                    <span className="text-micro text-ink-fg-3">
                      {t('today.groupCount', { count: group.items.length })}
                    </span>
                  </div>
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
                </section>
              )
            })
          )}
        </>
      )}
    </div>
  )
}
