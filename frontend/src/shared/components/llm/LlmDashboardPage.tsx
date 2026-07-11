// Sprint 6 §2.2 — /llm dashboard.
//
// Three blocks:
//   1. Cost summary cards (input/output tokens, cache hit rate, avg latency)
//   2. Status distribution (success / failed / gave_up / pending) — same
//      mini-histogram pattern as AdminPage so the visual language is
//      consistent
//   3. Selftest button (no-token health probe via `mailagent llm selftest`)
//
// We deliberately do NOT pull recharts / d3 — a hand-rolled SVG donut +
// horizontal bar are <30 LoC each and stay aligned with DESIGN.md's mono
// numeric tone. Karpathy simplicity wins.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { Activity, Sparkles, Zap } from 'lucide-react'

import type { LlmStatsData } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SkeletonCard } from '@shared/components/feedback/LoadingSkeleton'
import { toastError, toastSuccess } from '@shared/state/toast'

const RANGES: Array<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 }
]

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function StatCard({
  label,
  value,
  hint,
  accent
}: {
  label: string
  value: React.ReactNode
  hint?: string
  accent?: boolean
}): React.ReactElement {
  return (
    <div
      className={cn(
        // round 8c — 容器统一 accent 染色卡 (用户定稿「都要已处理那样的」),
        // accent prop 只剩数字字色/字重差异。
        'rounded-md border p-3 border-coral/30 bg-coral/5'
      )}
    >
      <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1">{label}</div>
      <div
        className={cn(
          'text-lead tabular-nums',
          accent ? 'text-coral font-semibold' : 'text-ink-fg'
        )}
      >
        {value}
      </div>
      {hint && <div className="text-meta text-ink-fg-3 mt-1">{hint}</div>}
    </div>
  )
}

// SVG donut for status distribution. Sized to fit a 240px card; passing
// counts={} renders an empty disc to keep layout stable.
function StatusDonut({ counts }: { counts: Record<string, number> }): React.ReactElement {
  const STATUS_COLOR: Record<string, string> = {
    success: 'rgb(var(--c-ok))',
    failed: 'rgb(var(--c-fail))',
    gave_up: 'rgb(var(--c-warn))',
    pending: 'rgb(var(--c-info))'
  }
  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  const radius = 56
  const stroke = 14
  const circumference = 2 * Math.PI * radius
  const order = ['success', 'failed', 'gave_up', 'pending']
  const keys = order
    .filter((k) => (counts[k] ?? 0) > 0)
    .concat(Object.keys(counts).filter((k) => !order.includes(k) && (counts[k] ?? 0) > 0))

  let cumulative = 0
  return (
    <div className="flex items-center gap-4">
      <svg width={140} height={140} viewBox="0 0 140 140" className="shrink-0">
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke="rgb(var(--ink-3))"
          strokeWidth={stroke}
        />
        {total > 0 &&
          keys.map((k) => {
            const fraction = counts[k] / total
            const dashLen = fraction * circumference
            const dashOffset = -cumulative * circumference
            cumulative += fraction
            return (
              <circle
                key={k}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke={STATUS_COLOR[k] ?? 'rgb(var(--ink-fg-3))'}
                strokeWidth={stroke}
                strokeDasharray={`${dashLen} ${circumference - dashLen}`}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 70 70)"
              />
            )
          })}
        <text
          x="70"
          y="68"
          textAnchor="middle"
          className="fill-ink-fg"
          style={{ font: '600 18px ui-sans-serif, system-ui' }}
        >
          {fmtNumber(total)}
        </text>
        <text
          x="70"
          y="86"
          textAnchor="middle"
          className="fill-ink-fg-2"
          style={{ font: '500 10px ui-monospace, monospace', letterSpacing: '0.08em' }}
        >
          TOTAL
        </text>
      </svg>
      <div className="flex-1 space-y-1 text-aux">
        {keys.length === 0 && <div className="text-ink-fg-3">—</div>}
        {keys.map((k) => (
          <div key={k} className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-sm"
                style={{ background: STATUS_COLOR[k] ?? 'rgb(var(--ink-fg-3))' }}
              />
              <span className="text-ink-fg-1">{k}</span>
            </span>
            <span className="font-mono tabular-nums text-ink-fg">{fmtNumber(counts[k])}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Simple gauge (0..100) for cache hit rate.
//
// Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — widen the
// info band so a real cache miss-rate that hovers around 30% doesn't
// flicker between warn/info on every refetch. New thresholds:
//   - >= 70%  → ok (target met)
//   - >= 20%  → info (working, not yet hot)
//   - <  20%  → warn (cold cache; system likely cold-started)
// 20% is loose enough that a single retry-storm minute doesn't flip it,
// and tight enough that a sustained miss rate still surfaces yellow.
function CacheGauge({ pct }: { pct: number }): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, pct))
  const color = clamped >= 70 ? 'bg-ok' : clamped >= 20 ? 'bg-info' : 'bg-warn'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-aux">
        <span className="text-ink-fg-1">{`${clamped.toFixed(1)}%`}</span>
        <span className="text-meta font-mono text-ink-fg-3">target ≥ 70%</span>
      </div>
      <div className="h-2 rounded bg-ink-fg/10 overflow-hidden">
        <div
          className={cn('h-full transition-all duration-fast', color)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

export function LlmDashboardPage(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const [days, setDays] = useState<number>(7)
  const [selftestPending, setSelftestPending] = useState(false)

  const statsQ = useQuery({
    queryKey: qk.llm.statsDays(days),
    queryFn: () => mailApi.llm.stats(days),
    staleTime: 30_000,
    refetchInterval: 60_000
  })

  const selftestMut = useMutation({
    mutationFn: () => mailApi.llm.selftest(),
    onMutate: () => setSelftestPending(true),
    onSuccess: (data) => {
      if (data.healthy) {
        toastSuccess(t('llm.selftestOk'), data.detail)
      } else {
        toastError(t('llm.selftestFail'), data.detail)
      }
      void qc.invalidateQueries({ queryKey: qk.llm.stats() })
    },
    onError: (err: unknown) => {
      const e = err as Error & { code?: string }
      toastError(t('llm.selftestFail'), e.message)
    },
    onSettled: () => setSelftestPending(false)
  })

  const data: LlmStatsData | undefined = statsQ.data
  const cost = data?.cost

  return (
    <div className="px-6 py-5 space-y-6 min-h-full">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-subj text-ink-fg font-semibold flex items-center gap-2">
          <Sparkles size={20} strokeWidth={1.75} className="text-coral" />
          {t('llm.title')}
        </h1>
        <div className="flex items-center gap-2">
          {/* Range chips — segmented control */}
          <div className="inline-flex rounded-md border border-ink-border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                onClick={() => setDays(r.days)}
                className={cn(
                  'px-2 py-1 text-aux rounded transition-colors duration-fast',
                  r.days === days
                    ? 'bg-coral/15 text-coral font-medium'
                    : 'text-ink-fg-1 hover:text-ink-fg'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => selftestMut.mutate()}
            disabled={selftestPending}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-aux',
              'bg-coral/100 text-accent-fg font-medium hover:bg-coral-hover',
              'transition-colors duration-fast',
              'disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          >
            <Zap
              size={13}
              strokeWidth={2}
              className={selftestPending ? 'animate-spin' : undefined}
            />
            {selftestPending ? t('llm.selftestPending') : t('llm.selftest')}
          </button>
        </div>
      </header>

      {/* Cost summary */}
      {data && cost && (
        <>
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label={t('llm.processed')}
              value={fmtNumber(data.total)}
              hint={t('llm.days', { n: data.days })}
              accent
            />
            <StatCard
              label={t('llm.inputTokens')}
              value={fmtTokens(cost.input_tokens)}
              hint={fmtNumber(cost.input_tokens)}
            />
            <StatCard
              label={t('llm.outputTokens')}
              value={fmtTokens(cost.output_tokens)}
              hint={fmtNumber(cost.output_tokens)}
            />
            <StatCard
              label={t('llm.avgLatency')}
              value={fmtMs(cost.avg_latency_ms)}
              hint={`over ${fmtNumber(cost.success_rows)} success`}
            />
          </section>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
              <div className="text-micro font-mono uppercase text-ink-fg-2 mb-3">
                {t('llm.statusDist')}
              </div>
              <StatusDonut counts={data.by_status} />
            </div>
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3 space-y-3">
              <div>
                <div className="text-micro font-mono uppercase text-ink-fg-2 mb-2">
                  {t('llm.cacheHit')}
                </div>
                <CacheGauge pct={cost.cache_hit_rate_pct} />
              </div>
              <div className="border-t border-ink-border-soft pt-3">
                <div className="text-micro font-mono uppercase text-ink-fg-2 mb-2">
                  {t('llm.cacheTokens')}
                </div>
                <div className="grid grid-cols-2 gap-3 text-aux">
                  <div>
                    <div className="text-meta text-ink-fg-3 mb-0.5">
                      {t('llm.cacheTokensCreation')}
                    </div>
                    <div className="font-mono tabular-nums text-ink-fg">
                      {fmtTokens(cost.cache_creation_input_tokens)}
                    </div>
                  </div>
                  <div>
                    <div className="text-meta text-ink-fg-3 mb-0.5">{t('llm.cacheTokensRead')}</div>
                    <div className="font-mono tabular-nums text-ink-fg">
                      {fmtTokens(cost.cache_read_input_tokens)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {statsQ.isLoading && (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </section>
      )}
      {statsQ.isError && (
        <EmptyState
          icon={<Activity size={20} strokeWidth={1.75} className="text-fail" />}
          title={t('llm.error')}
          action={
            <button
              type="button"
              onClick={() => void statsQ.refetch()}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-aux',
                'text-coral border border-coral/30 hover:bg-coral/10 transition-colors duration-fast'
              )}
            >
              {t('admin.retry')}
            </button>
          }
        />
      )}
    </div>
  )
}
