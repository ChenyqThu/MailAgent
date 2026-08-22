// 通讯录 Agent **工作台**抽屉（v2 重构；原型 `mockups/contact-agent-v2/workbench.tsx`）。
//
// v2 的职责重切（owner dogfood 后拍板）：配置整体搬去 Agents 页的「通讯录治理」卡，这个
// 460px 抽屉只回答两件事 ——
//   ① 有什么等我确认（「待审建议」tab）
//   ② 它最近跑得怎么样（「运行」tab）
// 原来的第三个 tab「它能做什么」（工具清单 + 提示词编辑器）整段搬走；脚上原来那个
// 「现在跑一次治理扫描」上移进「运行」tab 的第一屏（它是运行面的主动作，挂在脚上时两个
// tab 都看得见它，语义上只属于其中一个），脚位换成去 Agents 页的跳转行。
//
// 🔴 队列 tab 渲染**两批**：pending + blocked。后端 `list_suggestions` 只收单个
// status，所以是两条查询。blocked = 采纳时被不变量守卫拦下的行（服务端主动把它写成
// blocked 并返回错误信封），验收要求它「留在队列里」，所以必须看得见；但它不给
// 采纳/忽略按钮 —— 后端只允许 pending 被 adopt/ignore，画出来就是必然 400 的假入口。
//
// 🔴 零乐观更新：采纳/忽略都只在服务端落定后失效缓存，失败时那张卡留在原位
// （§4.2 纪律，与画像建议值同一条）。
//
// 🔴 merge 类的「采纳」不落合并：服务端把这条标 adopted 并交回**升序归一**的 id 对，
// 前端据此关抽屉 + 直入合并预览（唯一的人工确认路径）。
//
// 🔴 「上次扫描失败」出现在**两处**且口径一致：建议 tab 顶部一句短警示（空队列不等于
// 没发现问题）+ 运行 tab 的「上次扫描」整行（带错误码与下一步）。两处读的是同一条
// agent-status 查询，不会各说各话。

import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  CircleCheckBig,
  CircleDot,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  UserSearch,
  X
} from 'lucide-react'

import type {
  ContactAgentHistoryItem,
  ContactGovernanceSuggestion
} from '@shared/api/types/contact'
import { Drawer } from '@shared/components/ui/drawer'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { useAgentsNavigation } from '@shared/components/agents/navigation'
import { useContactNavigation } from '@shared/components/contacts/navigation'
// 🔴 单源：治理行 id 与画像行 id 并排住在 `agents/shared.ts`（零依赖常量叶子），不在
// contacts 侧另抄一份 —— 抄一份就等于两处 id 可以各自漂。
import { CONTACT_GOVERNANCE_AGENT_ID } from '@shared/components/agents/shared'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { toastError, toastInfo, toastSuccess } from '@shared/state/toast'

import { ContactSuggestionCard } from './ContactSuggestionCard'
import { ContactPip, SecHead } from './parts'
import {
  useContactAgentHistory,
  useContactAgentStatus,
  useContactList,
  useContactProfileDailySummary,
  useContactSuggestions,
  useContactsApi,
  useInvalidateContactSuggestions
} from './hooks'

type AgentTab = 'queue' | 'runs'

/** 治理 job 的读态。`queued` 与 `running` 在界面上是同一档（「还没有结果」），但值域
 *  必须四值齐全 —— 漏一个就会掉进「未知状态不渲染」的静默分支。 */
type ScanStatus = ContactAgentHistoryItem['status']

const SCAN_TONE: Record<ScanStatus, 'ok' | 'critical' | 'info'> = {
  succeeded: 'ok',
  failed: 'critical',
  running: 'info',
  queued: 'info'
}

// 时刻单位：三个端点（agent/status · agent/history · profile/daily-summary）对外契约
// 已统一为 epoch 毫秒（async_jobs 的秒在服务端出口转换），前端不再归一。

function ScanStatusPip({ status }: { status: ScanStatus }): React.ReactElement {
  const { t } = useTranslation()
  const settled = status === 'succeeded' || status === 'failed'
  return (
    <ContactPip
      tone={SCAN_TONE[status]}
      icon={
        settled ? (
          <CircleDot size={9.5} aria-hidden />
        ) : (
          <Loader2 size={9.5} aria-hidden className="animate-spin" />
        )
      }
    >
      {t(`contacts.agent.runs.status.${status}`)}
    </ContactPip>
  )
}

/** 「今天 04:00」「昨天 04:00」「08-15 04:00」—— 历史列表一列放得下的最短形式。
 *  相对时间（「3 小时前」）留给「上次扫描」那一行：那里问的是新鲜度，这里问的是「哪天挂了」。 */
function useWhenLabel(): (ms: number, now: number) => string {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'zh-CN'
  return (ms, now) => {
    const at = new Date(ms)
    const today = new Date(now)
    const hm = at.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    const sameDay = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    if (sameDay(at, today)) return t('contacts.agent.runs.today', { time: hm })
    if (sameDay(at, new Date(now - 86_400_000))) {
      return t('contacts.agent.runs.yesterday', { time: hm })
    }
    const md = at.toLocaleDateString(locale, { month: '2-digit', day: '2-digit' })
    return `${md} ${hm}`
  }
}

/* ── 运行 tab ─────────────────────────────────────────────────────────── */

/** 上次扫描状态行。三档各自说清「下一步该做什么」：失败带错误码 + 一句人话
 *  （`E_DISABLED` 的人话是「行停用了，去 Agents 页开」，不是干巴巴一个码）；
 *  成功说产出几条；进行中不给假进度条。 */
function LastScanRow({
  status,
  error,
  at,
  produced,
  now
}: {
  status: ScanStatus
  error: string | null
  /** epoch 毫秒；未知 → null（不画一个假时间）。 */
  at: number | null
  produced: number | null
  now: number
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const detail =
    status === 'succeeded'
      ? t('contacts.agent.runs.detailOk', { count: produced ?? 0 })
      : status === 'failed'
        ? error === 'E_DISABLED'
          ? t('contacts.agent.runs.detailDisabled')
          : t('contacts.agent.runs.detailFailed')
        : t('contacts.agent.runs.detailRunning')

  return (
    <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-meta font-medium text-ink-fg">
          {t('contacts.agent.runs.lastScan')}
        </span>
        <ScanStatusPip status={status} />
        {error !== null && error !== '' ? (
          <code className="shrink-0 font-mono text-micro text-fail">{error}</code>
        ) : null}
        <span aria-hidden className="flex-1" />
        {at !== null ? (
          <span className="shrink-0 text-micro tabular-nums text-ink-fg-3">
            {formatMatterAgo(at, now, i18n.language || 'zh-CN')}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-micro leading-[1.6] text-ink-fg-2 [text-wrap:pretty]">{detail}</p>
    </div>
  )
}

/** 历史一行：时间 / 状态 / 手动标记 / 产出 或 错误码。触发来源来自 history 端点的
 *  `trigger_kind`（params_json 透传）；定时是常态不标，只有 manual 标一枚，老行缺字段
 *  → null → 不标。 */
function ScanHistoryRow({
  run,
  now,
  whenLabel
}: {
  run: ContactAgentHistoryItem
  now: number
  whenLabel: (ms: number, now: number) => string
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 rounded-[var(--r-ctl)] px-[9px] py-1.5 odd:bg-ink-fg/[0.025]">
      <span className="w-[76px] shrink-0 font-mono text-micro tabular-nums text-ink-fg-2">
        {whenLabel(run.created_at, now)}
      </span>
      <ScanStatusPip status={run.status} />
      {run.trigger_kind === 'manual' ? (
        <ContactPip tone="neutral">{t('contacts.agent.runs.manual')}</ContactPip>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-micro text-ink-fg-2">
        {run.last_error !== null && run.last_error !== '' ? (
          <code className="font-mono text-micro text-fail">{run.last_error}</code>
        ) : run.status === 'succeeded' && run.suggestions_created !== null ? (
          t('contacts.agent.runs.produced', { count: run.suggestions_created })
        ) : (
          '—'
        )}
      </span>
    </div>
  )
}

/** 画像批处理小节 —— 另一个 agent 行（`contact_profile_agent`）的**只读镜子**。
 *  🔴 这里不放开关：那行的开关在 Agents 页「联系人画像」卡上，两处都能改会立刻分裂出
 *  「哪个是权威」（原型裁量 5）。 */
function ProfileBatchSection({
  now,
  whenLabel
}: {
  now: number
  whenLabel: (ms: number, now: number) => string
}): React.ReactElement {
  const { t } = useTranslation()
  const summary = useContactProfileDailySummary(true)
  const data = summary.data

  return (
    <div>
      <SecHead
        icon={<UserSearch size={13} aria-hidden className="shrink-0 text-ink-fg-2" />}
        title={t('contacts.agent.runs.profileTitle')}
      />
      {summary.isError ? (
        <p className="text-micro leading-[1.6] text-warn">
          {t('contacts.agent.runs.profileLoadFailed')}
        </p>
      ) : data === undefined ? (
        <p className="text-micro leading-[1.6] text-ink-fg-3">{t('contacts.agent.runs.loading')}</p>
      ) : (
        <>
          <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-3 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="text-meta text-ink-fg-1">
                {t('contacts.agent.runs.profileToday')}
              </span>
              <span className="font-mono text-aux font-semibold tabular-nums text-ink-fg">
                {data.attempted}
              </span>
              <span className="text-meta text-ink-fg-2">
                {t('contacts.agent.runs.profileUnit')}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <ContactPip tone="ok">
                {t('contacts.agent.runs.profileOk', { count: data.ok })}
              </ContactPip>
              <ContactPip>
                {t('contacts.agent.runs.profileSkipped', { count: data.skipped })}
              </ContactPip>
              <ContactPip tone={data.failed > 0 ? 'critical' : 'neutral'}>
                {t('contacts.agent.runs.profileFailed', { count: data.failed })}
              </ContactPip>
            </div>
            <p className="mt-2 text-micro leading-[1.6] text-ink-fg-3">
              {data.last_attempted_at !== null
                ? t('contacts.agent.runs.profileFoot', {
                    last: whenLabel(data.last_attempted_at, now),
                    hour: String(data.fire_hour).padStart(2, '0')
                  })
                : t('contacts.agent.runs.profileFootNever', {
                    hour: String(data.fire_hour).padStart(2, '0')
                  })}
            </p>
          </div>
          <p className="mt-[7px] text-micro leading-[1.6] text-ink-fg-3">
            {t('contacts.agent.runs.skippedNote')}
          </p>
        </>
      )}
    </div>
  )
}

function RunsTab({
  now,
  lastScanStatus,
  lastScanError,
  lastScanAt,
  running,
  onRun
}: {
  now: number
  lastScanStatus: ScanStatus | null
  lastScanError: string | null
  lastScanAt: number | null
  running: boolean
  onRun: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const whenLabel = useWhenLabel()
  const history = useContactAgentHistory(true)
  const runs = history.data?.items ?? []
  // 「上次扫描」那一行的产出条数只有历史端点知道（agent-status 不带它）——
  // 取历史第一条里 job 相同的那次；取不到就不报数（0 与「不知道」是两回事）。
  const latestRun = runs[0]
  const produced =
    latestRun !== undefined && latestRun.status === lastScanStatus
      ? latestRun.suggestions_created
      : null

  return (
    <div className="flex flex-col gap-4">
      <div>
        {/* 主动作上移进运行 tab 的第一屏：整宽、accent soft 底，是这一屏唯一的写入口。 */}
        <button
          type="button"
          disabled={running}
          onClick={onRun}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-[var(--r-ctl)] border border-coral/30 bg-coral/10 px-3 py-2 text-body font-medium text-coral transition-colors duration-fast ease-standard hover:bg-coral/[0.17] disabled:pointer-events-none disabled:opacity-60"
        >
          {running ? (
            <Loader2 size={14} aria-hidden className="animate-spin" />
          ) : (
            <RefreshCw size={14} aria-hidden />
          )}
          {t(running ? 'contacts.agent.running' : 'contacts.agent.runNow')}
        </button>
        <p className="mt-1.5 text-micro leading-[1.6] text-ink-fg-3">
          {t('contacts.agent.runs.runNote')}
        </p>
        {lastScanStatus !== null ? (
          <div className="mt-2.5">
            <LastScanRow
              status={lastScanStatus}
              error={lastScanError}
              at={lastScanAt}
              produced={produced}
              now={now}
            />
          </div>
        ) : null}
      </div>

      <div>
        <SecHead
          icon={<RefreshCw size={13} aria-hidden className="shrink-0 text-ink-fg-2" />}
          title={t('contacts.agent.runs.historyTitle')}
          count={history.isSuccess ? runs.length : undefined}
        />
        {history.isError ? (
          <p className="text-micro leading-[1.6] text-warn">
            {t('contacts.agent.runs.historyLoadFailed')}
          </p>
        ) : history.isPending ? (
          <p className="text-micro leading-[1.6] text-ink-fg-3">
            {t('contacts.agent.runs.loading')}
          </p>
        ) : runs.length === 0 ? (
          <p className="text-micro leading-[1.6] text-ink-fg-3">
            {t('contacts.agent.runs.historyEmpty')}
          </p>
        ) : (
          <div className="flex flex-col">
            {runs.map((run) => (
              <ScanHistoryRow key={run.job_id} run={run} now={now} whenLabel={whenLabel} />
            ))}
          </div>
        )}
      </div>

      <ProfileBatchSection now={now} whenLabel={whenLabel} />
    </div>
  )
}

/* ── 抽屉本体 ─────────────────────────────────────────────────────────── */

export interface ContactAgentDrawerProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** 点建议卡上的头像 → 关抽屉并打开那个人的档案。 */
  onOpenPerson(contactId: number): void
  /** merge 类采纳 → 关抽屉并直入合并预览步骤 2。 */
  onMergePair(pair: [number, number]): void
}

export function ContactAgentDrawer({
  open,
  onOpenChange,
  onOpenPerson,
  onMergePair
}: ContactAgentDrawerProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const api = useContactsApi()
  const invalidate = useInvalidateContactSuggestions()
  const openAgentConfig = useAgentsNavigation((state) => state.openConfig)
  const [tab, setTab] = useState<AgentTab>('queue')
  // 通知中心 `contact_queue` 深链要把 tab 切回「待审建议」——但抽屉**恒挂载**
  // （ContactsWorkspace 只切 `open` prop），backdrop 外的铃铛在抽屉已经开着时也能点，
  // 所以不能靠 `open` 的边沿判断：抽屉已经开着时再点一条通知，`open` 根本不会变化。
  // 改订阅 store 里的自增 nonce（每次 openQueue() 递增，clearQueue 不重置）——不管抽屉
  // 当前开没开，nonce 一变就切，覆盖「深链拉开」与「已开着时再来一条」两种时序。
  const queueNonce = useContactNavigation((state) => state.queueNonce)
  useEffect(() => {
    setTab('queue')
  }, [queueNonce])
  // render 期不许调 Date.now()（react-hooks/purity）—— ContactDetail 同款快照模式。
  const [now] = useState(() => Date.now())

  const pending = useContactSuggestions('pending', open)
  const blocked = useContactSuggestions('blocked', open)
  // WP7 dogfood 修复：治理 job failed 之后抽屉里零呈现 —— 用户点了「现在跑一次」，看到的
  // 只是「什么都没发生」（实测 job 是 failed E_DISABLED）。这里读同一条 agent-status 查询
  // （key 与胶囊徽标同源，react-query 去重，不多发请求）把终态显出来。
  // 🔴 两个键都是 optional：后端还没上线时是 undefined → 一行都不渲染。
  const agentStatus = useContactAgentStatus(open)
  const lastScanStatus = agentStatus.data?.last_scan_status ?? null
  const lastScanError = agentStatus.data?.last_scan_error ?? null
  const lastScanAt = agentStatus.data?.last_scan_at ?? null
  const scanInFlight = lastScanStatus === 'queued' || lastScanStatus === 'running'
  // 相关人名字/头像的查表源。🔴 有意**不传 limit**：按往来密度截断会正好丢掉建议指向的
  // 那类冷门行（机器人 / 刚换的新地址），而查不到名字的卡只能显示 `#id`。
  // （工作台主列表 2026-08-20 起改走分页的 `useContactListPaged`，两者不再共享缓存 ——
  //  这一整份目录是打开抽屉时的一次性代价，抽屉不开就不发。）
  const directory = useContactList({ view: 'all', q: '', sort: 'density', enabled: open })

  const personById = new Map((directory.data?.items ?? []).map((row) => [row.id, row]))

  const adopt = useMutation({
    mutationFn: (suggestion: ContactGovernanceSuggestion) => api.adoptSuggestion(suggestion.id),
    onSuccess: async (result, suggestion) => {
      await invalidate()
      const pair = result.merge_pair
      if (suggestion.type === 'merge' && pair !== undefined && pair.length === 2) {
        onOpenChange(false)
        onMergePair([pair[0] as number, pair[1] as number])
        return
      }
      toastSuccess(t('contacts.toast.suggestionAdopted'))
    },
    // 🔴 被守卫拦下走的是**错误信封**（那一行已经提交成 blocked）——失效后它会从
    // blocked 那条查询里读回来，在「被拦下的建议」小节显示原因。不当异常吞掉。
    onError: async (error) => {
      await invalidate()
      toastError(t('contacts.toast.suggestionBlocked'), errorMessage(error))
    }
  })

  const ignore = useMutation({
    mutationFn: (suggestion: ContactGovernanceSuggestion) => api.ignoreSuggestion(suggestion.id),
    onSuccess: async () => {
      await invalidate()
      toastSuccess(t('contacts.toast.suggestionIgnored'))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })

  const run = useMutation({
    mutationFn: () => api.runAgentScan(),
    onSuccess: async (result) => {
      await invalidate()
      // 🔴 端点只入队，不等扫描结束 —— 文案说「已排入」而不是「已完成」。
      if (result.coalesced) toastInfo(t('contacts.toast.scanCoalesced'))
      else toastSuccess(t('contacts.toast.scanQueued'))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })

  const pendingItems = pending.data?.items ?? []
  const blockedItems = blocked.data?.items ?? []
  const queueEmpty =
    !pending.isPending &&
    !blocked.isPending &&
    pendingItems.length === 0 &&
    blockedItems.length === 0
  const busy = adopt.isPending || ignore.isPending

  const renderCard = (suggestion: ContactGovernanceSuggestion): React.ReactElement => (
    <ContactSuggestionCard
      key={suggestion.id}
      suggestion={suggestion}
      personOf={(contactId) => personById.get(contactId)}
      busy={busy}
      onAdopt={(item) => adopt.mutate(item)}
      onIgnore={(item) => ignore.mutate(item)}
      onOpenPerson={(contactId) => {
        onOpenChange(false)
        onOpenPerson(contactId)
      }}
    />
  )

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width={460}
      ariaLabel={t('contacts.agent.title')}
    >
      <div className="flex shrink-0 items-center gap-[9px] border-b border-ink-border-soft px-4 py-[13px]">
        <span className="grid size-[26px] shrink-0 place-items-center rounded-[var(--r-ctl)] bg-ai/[0.12] text-ai">
          <Sparkles size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-aux font-semibold text-ink-fg">{t('contacts.agent.title')}</div>
          {/* v2 把副标的前半句「通讯录作为内置工具注入」删了（i18n 值改，key 不变）——
              那是在讲工具面，而工具面已经搬去 Agents 页；留着它会让人在这个抽屉里找一个
              不存在的清单。 */}
          <div className="mt-px text-micro text-ink-fg-2">{t('contacts.agent.subtitle')}</div>
        </div>
        <button
          type="button"
          aria-label={t('contacts.agent.close')}
          title={t('contacts.agent.close')}
          onClick={() => onOpenChange(false)}
          className="grid size-[26px] shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg"
        >
          <X size={14} />
        </button>
      </div>

      <div className="shrink-0 px-4 pt-2.5">
        <SegmentedControl<AgentTab>
          ariaLabel={t('contacts.agent.title')}
          value={tab}
          onChange={setTab}
          options={[
            {
              value: 'queue',
              label: t('contacts.agent.tab.queue', { count: pendingItems.length })
            },
            { value: 'runs', label: t('contacts.agent.tab.runs') }
          ]}
        />
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3">
        {tab === 'queue' ? (
          <>
            {pending.isError || blocked.isError ? (
              <p className="mb-2 text-meta leading-[1.6] text-warn">
                {t('contacts.agent.loadFailed')}
              </p>
            ) : null}
            {/* 扫描本身失败 ≠ 队列读取失败：前者是「这一轮压根没跑出来」，空队列是假象。
                同一件事在「运行」tab 有整行的详版，这里只留一句短警示，口径一致。 */}
            {lastScanStatus === 'failed' ? (
              <p className="mb-2 text-micro leading-[1.6] text-warn">
                {t('contacts.agent.scanFailed', { error: lastScanError ?? '—' })}
              </p>
            ) : null}
            {queueEmpty ? (
              <EmptyState
                icon={<CircleCheckBig size={20} strokeWidth={1.5} />}
                title={t('contacts.agent.empty.title')}
                hint={t('contacts.agent.empty.hint')}
              />
            ) : (
              <>
                {/* 采纳/忽略后该卡从服务端投影里消失 → 只做透明度过渡（红线：不许位移动画）。 */}
                <div
                  className={cn(
                    'flex flex-col gap-[9px] transition-opacity duration-base ease-standard',
                    busy && 'opacity-70'
                  )}
                >
                  {pendingItems.map(renderCard)}
                </div>
                {blockedItems.length > 0 ? (
                  <div className="mt-4">
                    <SecHead
                      icon={<ShieldAlert size={13} aria-hidden className="shrink-0 text-fail" />}
                      title={t('contacts.agent.blocked.title')}
                      count={blockedItems.length}
                    />
                    <p className="mb-2 text-micro leading-[1.6] text-ink-fg-3">
                      {t('contacts.agent.blocked.hint')}
                    </p>
                    <div className="flex flex-col gap-[9px]">{blockedItems.map(renderCard)}</div>
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : (
          <RunsTab
            now={now}
            lastScanStatus={lastScanStatus}
            lastScanError={lastScanError}
            lastScanAt={lastScanAt}
            // 上一轮还在队列/在跑时也禁用 —— 否则再点一次只会被后端合流（coalesced），
            // 用户看到的又是「什么都没发生」。
            running={run.isPending || scanInFlight}
            onRun={() => run.mutate()}
          />
        )}
      </div>

      {/* 脚：原来放「现在跑一次」，v2 换成去 Agents 页的跳转行 —— 配置搬走了，这里必须有
          一条明说「去哪儿改」的路，否则用户会在这个抽屉里找一个不存在的入口。 */}
      <button
        type="button"
        onClick={() => {
          openAgentConfig(CONTACT_GOVERNANCE_AGENT_ID)
          onOpenChange(false)
          void navigate({ to: '/agents', search: { tab: 'agents' } })
        }}
        className="flex shrink-0 items-center gap-2 border-t border-ink-border-soft px-4 py-[11px] text-left transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.04]"
      >
        <span className="min-w-0 flex-1 text-micro leading-[1.5] text-ink-fg-2">
          {t('contacts.agent.gotoConfig')}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-meta text-coral">
          {t('contacts.agent.gotoConfigCta')}
          <ArrowRight size={12} aria-hidden />
        </span>
      </button>
    </Drawer>
  )
}
