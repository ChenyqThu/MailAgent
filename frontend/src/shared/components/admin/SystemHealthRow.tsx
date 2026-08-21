// task 08-20-perf-dashboards §2.4 —「健康一眼看」状态行。
//
// 两个看板（/admin/kanban 与 /admin/llm）渲染**同一个组件、同一份数据源**：
// 一个人来看板通常只想回答一句「现在要不要动手」，而这句话此前散在两页七八张卡里。
//
// 每一格的入选判据只有一条：**它能直接回答「要不要动手」**。所以这里放的是
// 后端存活 / db_version 一致 / DavMail level / 死信 / outbox 积压与最老年龄 /
// KOS dead / Agent 待审批 / 告警 critical，而不是「总邮件数」这类看着热闹但不
// 触发行动的量。
//
// 🔴 数据全部复用既有 query key（admin.health / admin.stats / admin.davmailHealth /
// admin.systemAlerts / kos.statsDays(7) / agentRuns.pendingCount），不新开端点：
// 在 /admin/kanban 上它们与页面自己的 query 共享同一份缓存，多出来的只有 /llm 页
// 的那几个 —— 而这些读端点在本批之后都是 ~5ms 的 loopback SELECT。
//
// 🔴 KOS 的 dead_count 是**全量**口径（后端 collect_kos_stats 明确不按窗口裁），
// 与「近 N 天」的窗口计数不是一个量纲 —— 所以这里固定用 7d 的 key 取（dead 与
// days 无关，用 7d 只是为了跟 /llm 默认 range 共享缓存），文案上标「全量」。

import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { cn } from '@shared/lib/cn'
import { useAgentPendingCount, useCustomAgentsEnabled } from '@shared/components/agents/hooks'

type Tone = 'ok' | 'warn' | 'fail' | 'unknown'

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  fail: 'bg-fail',
  unknown: 'bg-ink-fg-3'
}

const VALUE_TEXT: Record<Tone, string> = {
  ok: 'text-ink-fg',
  warn: 'text-warn',
  fail: 'text-fail',
  unknown: 'text-ink-fg-3'
}

interface HealthItem {
  key: string
  label: string
  value: string
  tone: Tone
  /** 鼠标悬停补充（口径 / 期望值 / 最老一条多久）。 */
  title?: string
}

function Cell({ item }: { item: HealthItem }): React.ReactElement {
  return (
    <div
      className="inline-flex items-center gap-1.5 text-aux"
      title={item.title}
      data-testid={`health-${item.key}`}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', DOT[item.tone])} />
      <span className="text-ink-fg-2">{item.label}</span>
      <span className={cn('font-mono tabular-nums', VALUE_TEXT[item.tone])}>{item.value}</span>
    </div>
  )
}

/** pending 行里最老的那一档（后端只给分布，谁最老要自己从粗到细挑第一个非空桶）。 */
function oldestPendingBucket(buckets: Record<string, number> | undefined): {
  key: string | null
  tone: Tone
} {
  if (!buckets) return { key: null, tone: 'ok' }
  if ((buckets['gt_30m'] ?? 0) > 0) return { key: 'gt_30m', tone: 'fail' }
  if ((buckets['lt_30m'] ?? 0) > 0) return { key: 'lt_30m', tone: 'warn' }
  if ((buckets['lt_5m'] ?? 0) > 0) return { key: 'lt_5m', tone: 'ok' }
  if ((buckets['lt_1m'] ?? 0) > 0) return { key: 'lt_1m', tone: 'ok' }
  return { key: null, tone: 'ok' }
}

export function SystemHealthRow(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const customAgentsEnabled = useCustomAgentsEnabled()
  const agentPending = useAgentPendingCount(customAgentsEnabled)

  const healthQ = useQuery({
    queryKey: qk.admin.health(),
    queryFn: () => mailApi.admin.health(),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
  const statsQ = useQuery({
    queryKey: qk.admin.stats(),
    queryFn: () => mailApi.admin.stats(),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
  const davmailQ = useQuery({
    queryKey: qk.admin.davmailHealth(),
    queryFn: () => mailApi.admin.davmailHealth(),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
  const alertsQ = useQuery({
    queryKey: qk.admin.systemAlerts(),
    queryFn: () => mailApi.admin.systemAlerts(),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
  const kosQ = useQuery({
    queryKey: qk.kos.statsDays(7),
    queryFn: () => mailApi.kos.stats(7),
    staleTime: 30_000,
    refetchInterval: 60_000
  })

  const items: HealthItem[] = []

  // ① 后端存活 —— 读端点自己就是探针：拿不到响应 = serve-api 不可达。
  items.push({
    key: 'backend',
    label: t('admin.healthRow.backend'),
    value: healthQ.isError
      ? t('admin.healthRow.unreachable')
      : healthQ.data
        ? t(healthQ.data.db_accessible ? 'admin.healthRow.up' : 'admin.healthRow.dbDown')
        : '—',
    tone: healthQ.isError
      ? 'fail'
      : healthQ.data
        ? healthQ.data.db_accessible
          ? 'ok'
          : 'fail'
        : 'unknown'
  })

  // ② db_version 一致 —— 不一致 = 装了新版但没跑迁移（或反过来），后面所有数字都可疑。
  if (healthQ.data) {
    const cur = healthQ.data.db_version
    const expected = healthQ.data.db_version_expected
    items.push({
      key: 'db-version',
      label: t('admin.healthRow.dbVersion'),
      value: cur == null ? '—' : `v${cur}`,
      tone: cur == null ? 'unknown' : cur === expected ? 'ok' : 'warn',
      title: `expected v${expected}`
    })
  }

  // ③ DavMail —— 没跑 davmail backend（watchdog 从没 tick）就整格不出现，
  //    而不是显示一个恒「未启动」的灰点。
  if (davmailQ.data?.enabled) {
    const level = davmailQ.data.level
    items.push({
      key: 'davmail',
      label: 'DavMail',
      value: t(`admin.healthRow.davmail.${level}`),
      tone:
        level === 'critical'
          ? 'fail'
          : level === 'warning'
            ? 'warn'
            : level === 'ok'
              ? 'ok'
              : 'unknown'
    })
  }

  // ④ 死信 —— 一封都不该有；有就得人去看。
  const deadLetters = statsQ.data?.sync_store?.by_status?.['dead_letter'] ?? null
  items.push({
    key: 'dead-letter',
    label: t('admin.healthRow.deadLetter'),
    value: deadLetters == null ? '—' : String(deadLetters),
    tone: deadLetters == null ? 'unknown' : deadLetters > 0 ? 'fail' : 'ok'
  })

  // ⑤ outbox 待派发 + 最老年龄档 —— 只给条数看不出严重性：3 条卡了半小时
  //    比 30 条刚进队列糟得多。
  const outbox = statsQ.data?.outbox
  const pending = outbox?.by_status?.['pending'] ?? null
  const oldest = oldestPendingBucket(outbox?.age_buckets)
  items.push({
    key: 'outbox',
    label: t('admin.healthRow.outbox'),
    value:
      pending == null
        ? '—'
        : oldest.key
          ? `${pending} · ${t(`admin.outboxAge.${oldest.key}`)}`
          : String(pending),
    tone: pending == null ? 'unknown' : pending === 0 ? 'ok' : oldest.tone,
    title: t('admin.healthRow.outboxHint')
  })

  // ⑥ KOS dead —— 自动重试已放弃、要人工 bulk 补推。未开入库的机器不出现这格。
  const kosGate = kosQ.data ? (kosQ.data.gate ?? (kosQ.data.enabled ? 'active' : 'flag_off')) : null
  if (kosGate === 'active') {
    const dead = kosQ.data?.dead_count ?? 0
    items.push({
      key: 'kos-dead',
      label: t('admin.healthRow.kosDead'),
      value: String(dead),
      tone: dead > 0 ? 'warn' : 'ok',
      title: t('admin.healthRow.kosDeadHint')
    })
  }

  // ⑦ Agent 待审批 —— 停在那儿等人点的 run；flag 关掉就整格不出现。
  if (customAgentsEnabled) {
    items.push({
      key: 'agent-pending',
      label: t('admin.healthRow.agentPending'),
      value: String(agentPending.total),
      tone: agentPending.total > 0 ? 'warn' : 'ok'
    })
  }

  // ⑧ 告警 critical —— 与 TitleBar 红点同一份 current-state 快照。
  const critical = alertsQ.data?.critical_count ?? null
  items.push({
    key: 'alerts',
    label: t('admin.healthRow.alerts'),
    value: critical == null ? '—' : String(critical),
    tone: critical == null ? 'unknown' : critical > 0 ? 'fail' : 'ok'
  })

  return (
    <section
      className="rounded-md border border-ink-border bg-ink-2/60 px-3 py-2 flex flex-wrap items-center gap-x-5 gap-y-2"
      data-testid="system-health-row"
      aria-label={t('admin.healthRow.title')}
    >
      {items.map((item) => (
        <Cell key={item.key} item={item} />
      ))}
    </section>
  )
}
