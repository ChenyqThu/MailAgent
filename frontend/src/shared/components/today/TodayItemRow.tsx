// 例外面的一条条目行（L4 批次 2 设计 §4.3）。
//
// 视觉密度照 `notifications/NotificationPanel::NotificationRow`（26px 图标容器 + 标题/时间一行
// + 摘要一行 + hover 出 `⋯`），多出来的一件是 **triage 说明是一等字段**：为什么这条会进队列，
// 直接写在行上，不要求用户点进去才知道。
//
// 响应位按源分四条（都复用既有通道，本行不新造写面）：
//   · run `paused_pending` → 行内展开嵌 `PendingApprovalPanel`（它本就是 session-scoped 的
//     独立卡，已在三处非 chat 位复用过）；本行以**现有 props** 嵌入，不改它的内部。
//   · 提案 → 一跳事项详情的评审卡（既有 matter deep-link：store intent + navigate）。
//   · 信号 → 行内 `⋯` 菜单 resolve / snooze / dismiss，复用既有 triage mutation。
//   · `paused_expired` / `failed` → 跳该 run 的执行记录（AgentRecordView 既有导航）。
//
// 🔴 pending 的**唯一真值**是 gateway 进程内存的 stash：渲染 `paused_pending` 行时 live 查一次
// `/approval/pending`，miss（404 / gateway 重启 / 不可达）→ 诚实降级成「已失效」，不给一个按了
// 没反应的批准键。分组仍只由后端读态决定（红线：前端不自行推导 state），这次探测只决定
// **行内的可操作性**。

import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'

import { PendingApprovalPanel } from '@shared/assistant/PendingApprovalPanel'
import { fetchPendingApproval } from '@shared/assistant/approvalRecordClient'
import { RunStateBadge } from '@shared/components/agents/CustomAgentDrawer'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { ageLabel } from '@shared/lib/ageLabel'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'

import type { AttentionAction } from '@shared/components/matters/hooks'
import type { TodayGroupId, TodayItem } from './todayGroups'
import {
  TODAY_GROUP_TONE,
  TODAY_SIGNAL_ACTION_LABEL_KEY,
  TODAY_SOURCE_ICONS,
  TODAY_TONE_CLASS
} from './todayVocab'

/** 相对时间的适用窗（同 NotificationPanel：过了一天就报绝对日期，「30 天前」没有信息量）。 */
const RELATIVE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface TodayRowHandlers {
  /** 打开事项详情（提案的评审卡 / 信号所属事项）。 */
  onOpenMatter(publicId: string): void
  /** 打开该次 run 的执行记录（headless 会话）。 */
  onOpenRecord(sessionId: number): void
  /** 信号 triage（复用既有 mutation，含乐观移除）。`reason` 只有 dismiss 会带
   *  （resolve/snooze 的端点不收理由，行内菜单也不给它们展开输入框）。 */
  onSignalAction(
    matterPublicId: string,
    signalId: number,
    action: AttentionAction,
    reason?: string
  ): void
  /** run `paused_pending` 行内展开 / 收起审批卡。 */
  onToggleExpand(itemId: string | null): void
  /** 决策落地后让父层刷新三条源。 */
  onDecided(): void
}

export function TodayItemRow({
  item,
  groupId,
  nowMs,
  expanded,
  menuOpen,
  onMenuOpenChange,
  handlers
}: {
  item: TodayItem
  groupId: TodayGroupId
  /** 由页面统一注入的「此刻」—— 逐行各读一次 `Date.now()` 会让同一屏的相对时间基准不一致，
   *  也过不了 react-hooks/purity。 */
  nowMs: number
  expanded: boolean
  menuOpen: boolean
  onMenuOpenChange(id: string | null): void
  handlers: TodayRowHandlers
}): React.ReactElement {
  const { t } = useTranslation()
  const moreRef = useRef<HTMLButtonElement>(null)
  const toneClass = TODAY_TONE_CLASS[TODAY_GROUP_TONE[groupId]]
  const icon = TODAY_SOURCE_ICONS[item.source]

  // 忽略（dismiss）的可选理由 —— 两步式，交互样式照 `_cardShell.tsx` 的拒绝理由框：
  // 第一次点「忽略本次」只把菜单换成一行输入框 + 确认，第二次点才真正决策。resolve/snooze
  // 端点不收理由，维持一键。菜单关闭（换行 / 点别处）时清空草稿 —— 同 `_cardShell` 的
  // 「返回不留存草稿」不变量，`useId` 而非字面量：一屏可能同时挂多条信号行。
  const [dismissReasonOpen, setDismissReasonOpen] = useState(false)
  const [dismissReasonText, setDismissReasonText] = useState('')
  const dismissReasonId = useId()
  useEffect(() => {
    if (!menuOpen) {
      setDismissReasonOpen(false)
      setDismissReasonText('')
    }
  }, [menuOpen])

  const isPausedPending = item.source === 'run' && item.state === 'paused_pending'
  const sessionId = item.source === 'run' ? item.link.sessionId : null
  // live 探测。key 用 `qk.agentApprovalPending(sessionId)` 本体 —— `PendingApprovalPanel`
  // 决策后 invalidate 的正是这个前缀，本行跟着重探、自动失活。
  const probe = useQuery({
    queryKey: qk.agentApprovalPending(sessionId),
    queryFn: () => (sessionId == null ? Promise.resolve(null) : fetchPendingApproval(sessionId)),
    enabled: isPausedPending && sessionId != null,
    staleTime: 3_000
  })
  const pending = probe.data ?? null
  const canApprove = isPausedPending && pending != null
  const stashMiss = isPausedPending && probe.isSuccess && pending == null

  const age = nowMs - item.at
  const time =
    item.at <= 0
      ? ''
      : age < RELATIVE_WINDOW_MS
        ? ageLabel(t, age)
        : new Date(item.at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })

  // 行主动作。等审批探测未落地时**不给入口** —— 否则那一瞬的点击会按「跳记录页」处理，
  // 用户以为点的是「去批准」。
  let primary: (() => void) | null = null
  if (item.source === 'proposal' || item.source === 'signal') {
    const publicId = item.link.matterPublicId
    primary = () => handlers.onOpenMatter(publicId)
  } else if (canApprove) {
    primary = () => handlers.onToggleExpand(expanded ? null : item.id)
  } else if (isPausedPending && !probe.isSuccess) {
    primary = null
  } else if (sessionId != null) {
    primary = () => handlers.onOpenRecord(sessionId)
  }

  const menuItems: PopmenuItem[] =
    item.source !== 'signal'
      ? []
      : dismissReasonOpen
        ? [
            {
              kind: 'custom' as const,
              id: 'dismiss-reason',
              content: (
                <DismissReasonForm
                  id={dismissReasonId}
                  value={dismissReasonText}
                  onChange={setDismissReasonText}
                  onBack={() => {
                    setDismissReasonOpen(false)
                    setDismissReasonText('')
                  }}
                  onConfirm={() => {
                    const trimmed = dismissReasonText.trim()
                    onMenuOpenChange(null)
                    handlers.onSignalAction(
                      item.link.matterPublicId,
                      item.link.signalId,
                      'dismissed',
                      trimmed.length > 0 ? trimmed : undefined
                    )
                  }}
                  t={t}
                />
              )
            }
          ]
        : (['resolved', 'snoozed', 'dismissed'] as const).map((action) => ({
            kind: 'action' as const,
            id: action,
            label: t(TODAY_SIGNAL_ACTION_LABEL_KEY[action]),
            // dismiss 的第一次点击只展开理由框（下面 dismissReasonOpen 分支），不立即决策 ——
            // Popmenu 默认点完就关菜单，`keepOpen` 挡掉这次自动关闭。
            keepOpen: action === 'dismissed',
            onSelect: () => {
              if (action === 'dismissed') {
                setDismissReasonOpen(true)
                return
              }
              onMenuOpenChange(null)
              handlers.onSignalAction(item.link.matterPublicId, item.link.signalId, action)
            }
          }))

  const face = (
    <>
      <RowFace icon={icon} iconClass={toneClass.icon} />
      <RowBody
        item={item}
        time={time}
        preview={canApprove ? (pending?.inputPreview ?? null) : null}
      />
    </>
  )

  return (
    <div data-testid="today-item" data-source={item.source}>
      <div
        className={cn(
          'group relative flex items-start gap-2.5 px-3 py-2.5',
          'border-b border-[var(--hairline)] last:border-b-0',
          'transition-colors duration-fast',
          menuOpen ? 'bg-ink-3' : 'hover:bg-ink-3'
        )}
      >
        {/* 主区：有响应位才是按钮。没有的（无会话的终态 run / 探测未落地）渲染成静态块 ——
            一个按了没反应的按钮比不可点更糟。 */}
        {primary === null ? (
          <span className="flex min-w-0 flex-1 gap-2.5 text-left">{face}</span>
        ) : (
          <button
            type="button"
            onClick={primary}
            aria-expanded={canApprove ? expanded : undefined}
            className="flex min-w-0 flex-1 gap-2.5 text-left"
          >
            {face}
          </button>
        )}

        {/* hover 唯一动作钮：更多（只有信号有 triage 菜单）。占位恒在、只淡入淡出。 */}
        {menuItems.length > 0 && (
          <span className="-mr-1 shrink-0">
            <button
              ref={moreRef}
              type="button"
              aria-label={t('today.menu.trigger')}
              title={t('today.menu.trigger')}
              onClick={(event) => {
                event.stopPropagation()
                onMenuOpenChange(menuOpen ? null : item.id)
              }}
              className={cn(
                'mt-px grid size-6 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 opacity-0',
                'transition-opacity duration-fast ease-standard',
                'hover:bg-ink-fg/[0.08] hover:text-ink-fg focus-visible:opacity-100 group-hover:opacity-100',
                menuOpen && 'opacity-100'
              )}
            >
              <MoreHorizontal size={13} />
            </button>
          </span>
        )}
        {/* 🔴 portal 档不是可选项：列表在 `overflow-y-auto` 容器里，行内 absolute 的菜单会被
            容器整块裁掉（贴底那几行等于点不出菜单）。 */}
        {menuOpen && menuItems.length > 0 ? (
          <Popmenu
            open
            onClose={() => onMenuOpenChange(null)}
            ariaLabel={t('today.menu.trigger')}
            items={menuItems}
            triggerRef={moreRef}
            portal
            align="end"
            width={208}
          />
        ) : null}
      </div>

      {/* stash miss = 这条审批已经点不动了（超时或应用重启）。诚实说出来，不展开卡；行主
          动作同时退化成「去看执行记录」。 */}
      {stashMiss && (
        <div className="px-3 pb-2.5">
          <div
            data-testid="today-stash-miss"
            className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-3/70 px-2.5 py-1.5 text-meta text-ink-fg-2"
          >
            {t('today.run.stashMiss')}
          </div>
        </div>
      )}

      {/* 行内审批卡。showExpiredState 传 false —— 失效态由上面那一块自己画，不重复两遍。 */}
      {expanded && canApprove && sessionId != null && (
        <div className="px-3 pb-3 pt-1.5">
          <PendingApprovalPanel
            sessionId={sessionId}
            agentName={item.title}
            onDecided={() => {
              handlers.onToggleExpand(null)
              handlers.onDecided()
            }}
          />
        </div>
      )}
    </div>
  )
}

/** dismiss 的可选理由框（`Popmenu` 的 `custom` 逃生舱内容）—— 两步式的第二步。
 *  交互样式照 `_cardShell.tsx` 的 `ApprovalActions` 拒绝理由框：一行 label + textarea +
 *  返回/确认。理由留空 → `onConfirm` 那侧已经把空串折成 `undefined`，这里只管输入。 */
function DismissReasonForm({
  id,
  value,
  onChange,
  onBack,
  onConfirm,
  t
}: {
  id: string
  value: string
  onChange(value: string): void
  onBack(): void
  onConfirm(): void
  t: TFunction
}): React.ReactElement {
  return (
    <div className="space-y-1.5 p-1">
      <label className="block text-meta text-ink-fg-3" htmlFor={id}>
        {t('today.menu.dismissReasonLabel')}
      </label>
      <textarea
        id={id}
        rows={2}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('today.menu.dismissReasonPlaceholder')}
        className="w-full resize-y rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1.5 text-aux text-ink-fg placeholder:text-ink-fg-3 focus:border-ink-border focus:outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onBack}
          className="mr-auto rounded-md text-meta text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-2"
        >
          {t('today.menu.dismissBack')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex h-7 items-center justify-center rounded-md bg-[rgb(var(--c-accent))] px-2.5 text-aux font-medium leading-none text-[rgb(var(--c-accent-fg))] transition-opacity duration-fast hover:opacity-90"
        >
          {t('today.menu.dismissConfirm')}
        </button>
      </div>
    </div>
  )
}

function RowFace({ icon, iconClass }: { icon: LucideIcon; iconClass: string }): React.ReactElement {
  const Icon = icon
  return (
    <span
      className={cn('mt-px grid size-[26px] shrink-0 place-items-center rounded-lg', iconClass)}
    >
      <Icon size={14} strokeWidth={2} />
    </span>
  )
}

function RowBody({
  item,
  time,
  preview
}: {
  item: TodayItem
  time: string
  /** 服务端审批 preview（`/approval/pending` 的 `inputPreview`）—— **不是**模型自述。 */
  preview: string | null
}): React.ReactElement {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-aux font-medium text-ink-fg">{item.title}</span>
        <span className="flex shrink-0 items-baseline gap-1.5">
          {/* run 的 9 值读态原样透传（RunStateBadge 是穷举 switch + assertNever）——
              `succeeded + paused_handoff` 永远画成「等待审批」而不是「成功完成」。 */}
          {item.source === 'run' && <RunStateBadge state={item.state} />}
          {time.length > 0 && <span className="font-mono text-micro text-ink-fg-3">{time}</span>}
        </span>
      </span>
      {/* triage 说明：一等字段，行上直读。 */}
      {item.triageLogic.length > 0 && (
        <span className="mt-0.5 line-clamp-2 text-meta text-ink-fg-2">{item.triageLogic}</span>
      )}
      {preview != null && preview.length > 0 && (
        <span className="mt-1 line-clamp-2 break-words rounded-md border border-ink-border-soft bg-ink-1/60 px-2 py-1 font-mono text-micro text-ink-fg-2">
          {preview}
        </span>
      )}
    </span>
  )
}
