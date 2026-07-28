// issue #59 R7 —「知识库入库」区（/llm dashboard 底部）。
//
// 数据面 = `mailagent kos stats` 的台账聚合（桌面 IPC kos:stats / 远程 web
// GET /api/kos/stats，两端同一个 src/kos/stats.py）。
//
// 🔴 门控照 DavMailHealthCard 先例（admin/DavMailHealthCard.tsx:78-90）：
//   ① 返回类型 `React.ReactElement | null`，gate 封在组件内，父组件无条件挂一行；
//   ② 先 `isLoading || !data` 再判 gate —— loading 期也 null，不闪空壳；
//   ③ **判据在后端算**，前端只读 `data.gate` 这一个三态值，不自己拼（不去数缺了哪个键）。
//
// 🔴 issue #64：gate 不满足**不再一律隐藏**。原本 `if (!data.enabled) return null` 让
// 每个从 ≤v1.19.0 升上来的 KOS 用户整区凭空消失（v1.19.1 新引入的两个 bulk 凭据键不会
// 随 .env.example 进已有 .env），且零线索。现在分两支：
//   - `flag_off`（用户没开入库，默认关 = 绝大多数机器）→ 仍整区不渲染。给不用 KOS 的人
//     挂一块「未启用」只是噪音。
//   - `missing_credentials`（开关开着但凭据缺）→ **显因**：区块保留，列出缺的键名 + 怎么配。
//     与 v1.16.1 为 issue #54 给 consumer 面做的 gate 显因同款
//     （IntegrationsTab.tsx 的 kosGate.consumerEnabled && !kosGate.configured）。
//
// ⚠️ 有意不用 `useKosGate()` / `kosConfigured`：那判的是 **consumer 面**凭据
// （chat 读 KOS 的 `KOS_OAUTH_CLIENT_*`）。本区是 **producer 面**（入库），真实
// 判据是 `MAILAGENT_KOS_INGEST_ENABLED` + `make_bulk_kos_client()` 读的那三个
// 键。两套凭据独立 —— 用 consumer 判据 gate 这里，会让「chat 能读 KOS 但从没推过」
// 的机器显示一个恒空的监控区，反向也会漏显示。
//
// 🔴 gate 与数据走**同一个** /api/kos/stats 响应，不为 gate 另开 fetch
// （同仓纪律：useLlmModels.ts:52-55 批2 review LOW-7；AccountsTab.tsx:84-86）。
//
// 图表沿用本页既有纪律：手搓 SVG，不引 recharts / d3。

import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Database } from 'lucide-react'

import type { KosIngestGate } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { cn } from '@shared/lib/cn'
import { NumberTicker } from '@shared/components/ui/number-ticker'

import { StatCard } from './StatCard'

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** epoch 秒 → 本地时间短串；null / 0 / 非数值 → null（调用侧决定占位文案）。 */
function fmtTs(ts: number | null | undefined): string | null {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return null
  return new Date(ts * 1000).toLocaleString()
}

/** 距今多久（DavMailHealthCard:70-75 同款口径）。用来钉死「这个时间戳有多旧」，
 *  防止一个 40 天前的值被当成刚推过 —— 见下方 lastSuccess 渲染处的注释。 */
function fmtAgo(ts: number | null | undefined): string | null {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return null
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

/** 按天 pushed 序列的迷你折线。空序列渲染一条基线，保持卡片高度稳定。 */
function Sparkline({
  points,
  className
}: {
  points: number[]
  className?: string
}): React.ReactElement {
  const w = 120
  const h = 28
  const max = Math.max(1, ...points)
  const step = points.length > 1 ? w / (points.length - 1) : w
  const d =
    points.length === 0
      ? `M0 ${h} L${w} ${h}`
      : points
          .map(
            (v, i) =>
              `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(h - (v / max) * h).toFixed(1)}`
          )
          .join(' ')
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={cn('overflow-visible', className)}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

/** 区标题。两个分支（正常 / 缺凭据）共用，保证「区块还在」这件事一眼可见。
 *  `trailing` 是标题右侧的补充信息（正常态放「最近成功」）。 */
function SectionHeading({ trailing }: { trailing?: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <h2 className="text-body text-ink-fg font-semibold flex items-center gap-2">
        <Database size={16} strokeWidth={1.75} className="text-coral" />
        {t('kos.ingest.title')}
      </h2>
      {trailing}
    </div>
  )
}

/** gate = `missing_credentials` 时替代整个看板的显因块（issue #64）。
 *
 *  缺哪些键**来自后端**（`missing_keys`），前端不去数「哪个 env 没配」—— 判据只有
 *  一份，在 `src/kos/stats.py`。🔴 只渲染键名；键值从来没到过 renderer。 */
function GateMissingNotice({ missingKeys }: { missingKeys: string[] }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <section className="space-y-3" data-testid="kos-ingest-section">
      <SectionHeading />
      <div
        className="rounded-md border border-warn/30 bg-warn/5 p-3 space-y-2"
        data-testid="kos-gate-missing"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle size={13} strokeWidth={2} className="shrink-0 mt-0.5 text-warn" />
          <div className="min-w-0 space-y-2">
            <div className="text-aux text-warn">{t('kos.ingest.gateMissing')}</div>
            {missingKeys.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {missingKeys.map((key) => (
                  <code
                    key={key}
                    className="font-mono text-micro text-ink-fg-1 bg-ink-3 rounded px-1.5 py-0.5"
                  >
                    {key}
                  </code>
                ))}
              </div>
            )}
            <div className="text-meta text-ink-fg-2">{t('kos.ingest.gateMissingHow')}</div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function KosIngestSection({ days }: { days: number }): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()

  const statsQ = useQuery({
    queryKey: qk.kos.statsDays(days),
    queryFn: () => mailApi.kos.stats(days),
    staleTime: 30_000,
    refetchInterval: 60_000
  })

  // ① loading / 无数据（含取数失败）→ null。放在 gate 之前：门控还没到手
  //    时任何渲染都可能是在给未启用的机器画空壳。
  if (statsQ.isLoading || !statsQ.data) return null
  const data = statsQ.data
  // ② 门控三态。后端不守约（字段缺席）时退回修复前的行为，而不是把整区当成缺凭据 ——
  //    宁可少说也不误报（同下方 healthOk 的 typeof guard 纪律）。
  const gate: KosIngestGate = data.gate ?? (data.enabled ? 'active' : 'flag_off')
  // ③ 用户没开入库 → 整区一行 DOM 都不渲染（默认关的机器不该多出一块东西）。
  if (gate === 'flag_off') return null
  // ④ 开着但凭据缺 → 显因，不再静默消失（issue #64）。
  if (gate === 'missing_credentials') {
    return <GateMissingNotice missingKeys={data.missing_keys ?? []} />
  }

  const pushed = data.by_status?.['pushed'] ?? 0
  // 🔴 与上面那个窗口计数是**两个量纲**：窗口数会因一次 bulk 滚出窗口而凭空掉一个
  // 量级（看起来像知识库被清空），累计数不会。两个必须并排出现，只给窗口数就是
  // issue #64 里 owner 把 7d 的 1670 读成「知识库总量」的那条路。
  const pushedAll = data.by_status_all?.['pushed'] ?? null
  const failed = data.by_status?.['failed'] ?? 0
  const skipped = data.by_status?.['skipped'] ?? 0
  // dead_count / pending_retry 恒全量（后端 collect_kos_stats 明确不按窗口裁），
  // 与上面三个窗口内计数不同量纲 —— hint 文案里标出来，别让人当成同一口径。
  const dead = data.dead_count ?? 0
  const pending = data.pending_retry ?? 0
  const errorCodes = Object.entries(data.by_error_code ?? {}).sort((a, b) => b[1] - a[1])
  const daily = data.daily ?? []
  // 🔴 健康三态判定：null = 从未探测（≠ 异常）/ true = 可达 / false = 不可达。
  //
  // 判据**不能**只写 `data.health == null` —— 上游可能返回「对象存在但 ok 不是
  // boolean」的形状（实测有过 `{status:null, checked_at:null, detail:null,
  // consecutive_failed_rounds:0}` 这种字段全 null 的对象）。那样 `health.ok` 是
  // undefined → falsy → 渲染成「不可达」，于是**刚升级、从未探活过的机器全都会
  // 看到 KOS 异常**。这里按 `typeof === 'boolean'` 收敛：只要拿不到真正的 boolean
  // 就退到「未探测」，宁可少报也不误报。类型上 ok 声明为 boolean，这道 guard 是
  // 有意的运行时防御 —— 不赌上游守约。
  const healthOk = typeof data.health?.ok === 'boolean' ? data.health.ok : null
  const lastSuccess = fmtTs(data.last_success_ts)
  const lastSuccessAgo = fmtAgo(data.last_success_ts)
  // checked_at 同样可能是 null（上同）→ fmtTs/fmtAgo 各自返 null，相对时间那段不渲染。
  const healthCheckedAt = fmtTs(data.health?.checked_at)
  const healthAgo = fmtAgo(data.health?.checked_at)
  // detail 是后端的契约外附加字段（探活失败原因）。不可达时它才是有用信息，
  // 挂在 tooltip 上：绝对时间 + 失败原因，不占行内空间。可选链 —— 可能整个字段不在。
  const healthTitle =
    [healthCheckedAt, data.health?.detail].filter((s) => s != null && s !== '').join(' · ') ||
    undefined
  // schema_stale = 装了新版但后端还没重启跑迁移的窗口：其余数字都是真的，
  // 只有 by_error_code 取不到 —— 此时说「窗口内无失败」是撒谎。
  const errorCodesUnavailable = data._source === 'schema_stale'

  return (
    <section className="space-y-3" data-testid="kos-ingest-section">
      {/* 🔴「最近成功」提到标题行：它是唯一能证明「入库还在跑」的信号，压在右下角
          小字里等于没有。没有记录时给「暂无记录」而不是渲染一个假装新鲜的时间戳；
          有记录时给「多久以前」（绝对时间进 tooltip）—— 只给绝对时间容易被扫读成
          刚推过，而这个值可能是很久以前的一次成功。 */}
      <SectionHeading
        trailing={
          <div className="text-aux flex items-center gap-1.5" data-testid="kos-last-success">
            <span className="text-ink-fg-2">{t('kos.ingest.lastSuccess')}</span>
            {lastSuccess == null ? (
              <span className="text-ink-fg-3">{t('kos.ingest.lastSuccessNone')}</span>
            ) : (
              <span className="font-mono tabular-nums text-ink-fg" title={lastSuccess}>
                {t('kos.ingest.ago', { t: lastSuccessAgo })}
              </span>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* 窗口数 + 累计数并排：单给窗口数会被读成「知识库总量」，而它会在一次 bulk
            滚出窗口时凭空掉一个量级（issue #64 B1）。 */}
        <StatCard
          label={t('kos.ingest.pushed')}
          value={<NumberTicker value={pushed} format={fmtNumber} />}
          hint={
            pushedAll == null
              ? t('llm.days', { n: data.days })
              : `${t('llm.days', { n: data.days })} · ${t('kos.ingest.cumulative', {
                  n: fmtNumber(pushedAll)
                })}`
          }
          accent
        />
        <StatCard
          label={t('kos.ingest.failed')}
          value={<NumberTicker value={failed} format={fmtNumber} />}
          hint={t('kos.ingest.pendingRetry', { n: pending })}
        />
        <StatCard
          label={t('kos.ingest.skipped')}
          value={<NumberTicker value={skipped} format={fmtNumber} />}
          hint={t('kos.ingest.skippedHint')}
        />
        {/* dead = 自动重试已放弃、需人工介入 —— 不能和普通计数长一样。 */}
        <StatCard
          label={t('kos.ingest.dead')}
          value={<NumberTicker value={dead} format={fmtNumber} />}
          tone={dead > 0 ? 'warn' : 'accent'}
          hint={
            dead > 0 ? (
              <span className="flex items-start gap-1 text-warn" data-testid="kos-dead-warning">
                <AlertTriangle size={11} strokeWidth={2} className="shrink-0 mt-0.5" />
                <span>{t('kos.ingest.deadHint')}</span>
              </span>
            ) : (
              t('kos.ingest.deadNone')
            )
          }
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-md border border-coral/30 bg-coral/5 p-3 space-y-2">
          <div className="text-micro font-mono uppercase text-ink-fg-2">
            {t('kos.ingest.errorDist')}
          </div>
          {errorCodes.length === 0 ? (
            <div className="text-aux text-ink-fg-3">
              {errorCodesUnavailable ? t('kos.ingest.errorUnavailable') : t('kos.ingest.errorNone')}
            </div>
          ) : (
            <div className="space-y-1 text-aux">
              {errorCodes.map(([code, n]) => (
                <div key={code} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-ink-fg-1 truncate">{code}</span>
                  <span className="font-mono tabular-nums text-ink-fg">{fmtNumber(n)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-md border border-coral/30 bg-coral/5 p-3 space-y-3">
          <div>
            <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1">
              {t('kos.ingest.trend')}
            </div>
            <Sparkline points={daily.map((d) => d.pushed)} className="text-coral" />
          </div>
          <div className="border-t border-ink-border-soft pt-2 space-y-1 text-aux">
            {/* 「最近成功」已提到区标题行（唯一能证明在跑的信号）——这里不再重复。 */}
            {/* 🔴 两点都不是实时状态：① health === null = 从未探测（中性色，不是异常）；
                ② 后端无积压时不探活，所以非 null 的 health 也可能是很旧的快照。故标题用
                「上次检查」而非「健康状态」，值里带相对时间 —— 「可达 · 3d 前」一眼能看出
                这是历史快照，「可达 · 2026-07-22 14:03」则会被当成刚测过。 */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-fg-2">{t('kos.ingest.healthLastCheck')}</span>
              {healthOk == null ? (
                <span className="font-mono text-ink-fg-3">{t('kos.ingest.healthUnknown')}</span>
              ) : (
                <span className="font-mono" title={healthTitle}>
                  <span className={healthOk ? 'text-ok' : 'text-fail'}>
                    {healthOk ? t('kos.ingest.healthOk') : t('kos.ingest.healthDown')}
                  </span>
                  {healthAgo != null && (
                    <span className="text-ink-fg-3 tabular-nums">
                      {` · ${t('kos.ingest.ago', { t: healthAgo })}`}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
