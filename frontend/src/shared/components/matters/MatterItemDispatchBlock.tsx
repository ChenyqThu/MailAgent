/**
 * 一条行动项的**执行契约**面（L4 批次 3 · A2）：派给谁、现在到哪一步、缺信息时回答它、
 * 以及这条行动项跑过几轮。
 *
 * 挂在行动项行下（只有 `kind='action'` 有执行契约 —— 服务端的表级 CHECK 也是这么划的）。
 *
 * 三条纪律：
 *  🔴 状态**只透传**服务端的 `state`（CAS 推进），前端不从「有没有 update_id」之类的痕迹
 *    自己推 —— 合成一列 / 自行推导正是这一批要终结的失效形态。
 *  🔴 一条行动项同时只有一次活跃派发（服务端 partial unique 是最终防线）；活跃时**不给**
 *    第二个派发入口，而不是画一个必然 409 的按钮。
 *  🔴 执行档改的是**行动项上的默认档**（`exec_profile`，走既有 item PATCH 面），派发时不
 *    再单独传一份 —— 服务端本来就会从 item 冻结。两处各传一份 = 两个会漂的真值。
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Bot, ChevronDown, ChevronRight, MessageSquare, Send, X } from 'lucide-react'

import type {
  MatterItem,
  MatterItemDispatch,
  MatterItemExecProfile
} from '@shared/api/types/matter'
import type { ReportAgentConfig } from '@shared/api/types'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/components/ui/select'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'

import { useItemDispatchAction } from './hooks'
import { MATTER_EXEC_PROFILE_OPTIONS, isLiveDispatchState } from './matterDispatchVocab'
import { MatterDispatchStateBadge } from './MatterDispatchStateBadge'

const BUILTIN_EXECUTOR = 'matter_followup'
const DEFAULT_PROFILE: MatterItemExecProfile = 'propose_only'

export function MatterItemDispatchBlock({
  matterId,
  item,
  dispatches,
  agents,
  now,
  locale,
  busy,
  onProfileChange,
  onReview
}: {
  matterId: string
  item: MatterItem
  /** 这条行动项的派发史，**newest-first**（服务端 `ORDER BY id DESC`）。 */
  dispatches: readonly MatterItemDispatch[]
  /** 可选的执行器（启用着的 custom agent）。内建跟进 Agent 恒在，不在这张表里。 */
  agents: readonly ReportAgentConfig[]
  now: number
  locale: string
  busy: boolean
  onProfileChange(profile: MatterItemExecProfile): void
  onReview(updateId: number): void
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const action = useItemDispatchAction()
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [answerOpen, setAnswerOpen] = useState(false)
  const [answerText, setAnswerText] = useState('')
  const [executorId, setExecutorId] = useState<string>(BUILTIN_EXECUTOR)

  // 这条行动项名下的全部会话（`ai_chat_sessions.item_id` 反查，含 headless 执行 run）——
  // 用来给每一轮派发配一条能点进去的会话。
  // 🔴 只在展开执行历史时才查：一屏可能有十几条行动项，挂载即查 = 十几个请求换一个默认折叠的面。
  const sessionsQuery = useQuery({
    queryKey: qk.chat.itemSessions(item.id),
    queryFn: () => mailApi.chat.listAllSessions({ itemId: item.id }),
    enabled: historyOpen && dispatches.length > 0,
    staleTime: 10_000
  })
  // 配对判据 = job：`ai_chat_sessions.agent_job_id` 是 **TEXT**（async_jobs.job_id 存成字符串），
  // 派发行上的是 number —— 比对前统一成字符串，否则永远配不上、跳转钮永远不出现。
  const sessionByJob = useMemo(() => {
    const map = new Map<string, number>()
    for (const session of sessionsQuery.data ?? []) {
      const jobId = session.agent_job_id
      if (typeof jobId === 'string' && jobId.length > 0) map.set(jobId, session.id)
    }
    return map
  }, [sessionsQuery.data])
  const sessionIdFor = (dispatch: MatterItemDispatch): number | null =>
    dispatch.async_job_id == null ? null : (sessionByJob.get(String(dispatch.async_job_id)) ?? null)

  const openSession = (sessionId: number): void => {
    // 既有的「打开这次 run 的执行记录」路径：park sessionId → 去 /sessions，AgentViewLayout
    // 挂载时消费并选中（与例外面的 run 行、设置里的 run 历史同一条）。不另造第二个会话视图。
    requestOpenAgentSession(sessionId)
    void navigate({ to: '/sessions' })
  }

  // 「活跃」判据 = 最新那一行的执行态（服务端保证同时至多一行活跃）。
  const latest = dispatches[0]
  const live = latest !== undefined && isLiveDispatchState(latest.state) ? latest : null
  // 🔴 `failed` 是终态、不再活跃，但仍要**在行上**出徽标：把「上一轮挂了」折进默认折叠的
  // 执行历史里，等于让失败静默 —— 那正是这一批要终结的失效形态。`done` / `canceled`
  // 不喊（没有下一步动作），只留在历史里。
  const headline = live ?? (latest?.state === 'failed' ? latest : null)
  const profile = item.exec_profile ?? DEFAULT_PROFILE
  const pending = action.isPending || busy

  const submitAnswer = (): void => {
    const text = answerText.trim()
    if (text.length === 0 || live === null) return
    setAnswerOpen(false)
    setAnswerText('')
    action.mutate({ matterId, dispatchId: live.id, action: 'answer', text })
  }

  return (
    <div data-testid="item-dispatch-block" data-item={item.id} className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        {headline !== null && <MatterDispatchStateBadge state={headline.state} />}
        {/* 失败原因当场说出来（不用展开历史）。 */}
        {headline !== null && headline.state === 'failed' && (
          <span className="text-micro text-fail">
            {typeof headline.error?.message === 'string'
              ? headline.error.message
              : typeof headline.error?.code === 'string'
                ? headline.error.code
                : ''}
          </span>
        )}
        {live !== null && (
          <>
            {live.state === 'awaiting_input' && !answerOpen && (
              <button
                type="button"
                disabled={pending}
                onClick={() => setAnswerOpen(true)}
                className="rounded-[var(--r-ctl)] border border-warn/30 px-2 py-0.5 text-micro text-warn transition-colors duration-fast hover:bg-warn/[0.08] disabled:opacity-50"
              >
                {t('matters.dispatch.answer')}
              </button>
            )}
            {live.state === 'proposed' && live.update_id != null && (
              <button
                type="button"
                onClick={() => onReview(live.update_id as number)}
                className="rounded-[var(--r-ctl)] border border-ink-border px-2 py-0.5 text-micro text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
              >
                {t('matters.dispatch.review')}
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => action.mutate({ matterId, dispatchId: live.id, action: 'cancel' })}
              className="rounded-[var(--r-ctl)] px-1.5 py-0.5 text-micro text-ink-fg-3 transition-colors duration-fast hover:text-fail disabled:opacity-50"
            >
              {t('matters.dispatch.cancel')}
            </button>
          </>
        )}
        {/* 🔴 活跃派发在场时**不给**第二个派发入口：服务端 partial unique 会拒（E_DISPATCH_ACTIVE），
            画一个必然报错的按钮比不画更糟。终态之后（含 failed）可以再派一轮。 */}
        {live === null && (
          <DispatchLauncher
            open={launcherOpen}
            agents={agents}
            executorId={executorId}
            profile={profile}
            pending={pending}
            canDispatch={item.status !== 'done' && item.status !== 'canceled'}
            onOpenChange={setLauncherOpen}
            onExecutorChange={setExecutorId}
            onProfileChange={onProfileChange}
            onConfirm={() => {
              setLauncherOpen(false)
              action.mutate({
                matterId,
                itemId: item.id,
                action: 'dispatch',
                // 🔴 不传 profile：服务端从 item 的 `exec_profile` 冻结（上面那颗 Select 改的
                // 就是它）。传一份等于把同一个真值写两遍。
                executorId: executorId === BUILTIN_EXECUTOR ? null : executorId
              })
            }}
          />
        )}
      </div>

      {answerOpen && live !== null && (
        <div
          data-testid="item-dispatch-answer"
          className="mt-1.5 space-y-1.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2/70 p-2"
        >
          <div className="text-meta text-ink-fg-2">
            {live.question?.question ?? t('matters.dispatch.answerLabel')}
          </div>
          {(live.question?.options ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(live.question?.options ?? []).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setAnswerText(option)}
                  className="rounded-full border border-ink-border-soft px-2 py-0.5 text-micro text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <textarea
            rows={2}
            autoFocus
            value={answerText}
            aria-label={t('matters.dispatch.answerLabel')}
            placeholder={t('matters.dispatch.answerPlaceholder')}
            onChange={(event) => setAnswerText(event.target.value)}
            className="w-full resize-y rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1.5 text-aux text-ink-fg placeholder:text-ink-fg-3 focus:border-ink-border focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAnswerOpen(false)
                setAnswerText('')
              }}
              className="mr-auto text-meta text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-2"
            >
              {t('matters.dispatch.answerBack')}
            </button>
            <button
              type="button"
              disabled={answerText.trim().length === 0 || pending}
              onClick={submitAnswer}
              className="inline-flex h-7 items-center justify-center rounded-md bg-[rgb(var(--c-accent))] px-2.5 text-aux font-medium leading-none text-[rgb(var(--c-accent-fg))] transition-opacity duration-fast hover:opacity-90 disabled:opacity-50"
            >
              {t('matters.dispatch.answerConfirm')}
            </button>
          </div>
        </div>
      )}

      {dispatches.length > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            className="inline-flex items-center gap-1 text-micro text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-2"
          >
            {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {t('matters.dispatch.history', { count: dispatches.length })}
          </button>
          {historyOpen && (
            <ul data-testid="item-dispatch-history" className="mt-1 space-y-1 pl-4">
              {dispatches.map((dispatch) => {
                const sessionId = sessionIdFor(dispatch)
                return (
                  <li key={dispatch.id} className="flex flex-wrap items-center gap-1.5">
                    <MatterDispatchStateBadge state={dispatch.state} />
                    <span className="text-micro text-ink-fg-3">
                      {t('matters.dispatch.attempt', { count: dispatch.attempt_count })}
                    </span>
                    <span className="text-micro text-ink-fg-3">
                      {formatMatterAgo(dispatch.dispatched_at, now, locale)}
                    </span>
                    <span className="text-micro text-ink-fg-3">{dispatch.executor_id}</span>
                    {/* 失败原因原样写在行上 —— 「挂了但不说为什么」是这一批要修的东西。 */}
                    {typeof dispatch.error?.code === 'string' && (
                      <span className="text-micro text-fail">{String(dispatch.error.code)}</span>
                    )}
                    {/* 🔴 配不到会话的轮次**不画**这颗钮（还没建会话 / 老库没有 item_id / 会话已删）：
                        点了什么都不发生的入口比没有入口更糟。 */}
                    {sessionId !== null && (
                      <button
                        type="button"
                        data-testid="item-dispatch-session"
                        data-session={sessionId}
                        onClick={() => openSession(sessionId)}
                        className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-micro text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
                      >
                        <MessageSquare size={11} />
                        {t('matters.dispatch.openSession')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** 派发入口：折叠时只有一颗按钮；展开后是「执行器 + 执行档 + 派发」三件。 */
function DispatchLauncher({
  open,
  agents,
  executorId,
  profile,
  pending,
  canDispatch,
  onOpenChange,
  onExecutorChange,
  onProfileChange,
  onConfirm
}: {
  open: boolean
  agents: readonly ReportAgentConfig[]
  executorId: string
  profile: MatterItemExecProfile
  pending: boolean
  /** 已完成 / 已取消的行动项不给派发入口（服务端也会拒）。 */
  canDispatch: boolean
  onOpenChange(open: boolean): void
  onExecutorChange(id: string): void
  onProfileChange(profile: MatterItemExecProfile): void
  onConfirm(): void
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (!canDispatch) return null
  if (!open) {
    return (
      <button
        type="button"
        data-testid="item-dispatch-start"
        onClick={() => onOpenChange(true)}
        className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-micro text-ink-fg-3 opacity-0 transition-all duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:opacity-100 group-hover/item:opacity-100"
      >
        <Bot size={11} />
        {t('matters.dispatch.start')}
      </button>
    )
  }
  return (
    <div
      data-testid="item-dispatch-launcher"
      className="flex flex-wrap items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2/70 px-2 py-1.5"
    >
      <Select value={executorId} onValueChange={onExecutorChange}>
        <SelectTrigger
          aria-label={t('matters.dispatch.executor')}
          className="h-7 w-auto min-w-[9rem] gap-1 text-micro"
        >
          {executorId === BUILTIN_EXECUTOR
            ? t('matters.dispatch.builtinExecutor')
            : (agents.find((agent) => agent.id === executorId)?.title ?? executorId)}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={BUILTIN_EXECUTOR}>{t('matters.dispatch.builtinExecutor')}</SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={profile}
        onValueChange={(next) => onProfileChange(next as MatterItemExecProfile)}
      >
        <SelectTrigger
          aria-label={t('matters.dispatch.profile')}
          className="h-7 w-auto min-w-[9rem] gap-1 text-micro"
        >
          {t(`matters.dispatch.profiles.${profile}`)}
        </SelectTrigger>
        <SelectContent>
          {/* 🔴 词表里有三档，这里只渲染两档：`edit_with_approval` 在提案制引擎里与
              `propose_only` 行为暂无差异，摆出来就是假选项（`matterDispatchVocab` 的
              `MATTER_EXEC_PROFILE_OPTIONS` 是那份取舍的单源）。 */}
          {MATTER_EXEC_PROFILE_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              <span className="flex flex-col">
                <span>{t(`matters.dispatch.profiles.${option}`)}</span>
                <span className="text-micro text-ink-fg-3">
                  {t(`matters.dispatch.profileHints.${option}`)}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <button
        type="button"
        disabled={pending}
        onClick={onConfirm}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md bg-[rgb(var(--c-accent))] px-2.5 text-micro font-medium',
          'leading-none text-[rgb(var(--c-accent-fg))] transition-opacity duration-fast hover:opacity-90 disabled:opacity-50'
        )}
      >
        <Send size={11} />
        {pending ? t('matters.dispatch.starting') : t('matters.dispatch.confirm')}
      </button>
      <button
        type="button"
        aria-label={t('matters.actions.cancel')}
        onClick={() => onOpenChange(false)}
        className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
      >
        <X size={12} />
      </button>
    </div>
  )
}
