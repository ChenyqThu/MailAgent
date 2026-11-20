// Phase 4 WP-4E — Settings「用量与缓存监控」仪表盘 + probelog 诊断面板。
//
// Design v3 铁律：
//   - 零硬编码 #hex（全部走语义 Tailwind token 或 rgb(var(--...)) CSS 变量）
//   - 中文文案最小 text-aux (14px)；font-mono text-meta 仅限纯 ASCII 数字/金额/百分比/模型 id
//   - 显式函数返回类型

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Activity, RefreshCw, Trash2 } from 'lucide-react'

import { ProviderBrandIcon } from '@shared/components/icons/providers'
import { Button } from '@shared/components/ui/button'
import {
  clearLlmProbeLogs,
  useLlmUsage,
  type LlmProbeLogEntry,
  type LlmUsageBucket,
  type LlmUsageRange
} from '@shared/hooks/useLlmUsage'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { lookupModelMeta } from '@shared/modelCatalog/lookup'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Section } from '../parts/Section'

const RANGES: readonly LlmUsageRange[] = ['24h', '7d', '30d']

function isWebBuild(): boolean {
  return (
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'
  )
}

function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function formatIsoTimeAscii(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--'
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function UsageTrendChart({
  series,
  ariaLabel
}: {
  series: readonly LlmUsageBucket[]
  ariaLabel: string
}): React.JSX.Element {
  const width = 640
  const height = 136
  const padX = 24
  const padTop = 14
  const padBottom = 22
  const plotW = width - padX * 2
  const plotH = height - padTop - padBottom

  const maxTokens = Math.max(
    1,
    ...series.map((b) => b.inputTokens + b.outputTokens)
  )
  const n = Math.max(1, series.length)
  const slotW = plotW / n
  const barW = Math.max(3, Math.min(20, slotW * 0.62))

  const hitPoints = series
    .map((b, i) => {
      const cx = padX + slotW * i + slotW / 2
      const pct = Math.max(0, Math.min(100, b.tokenCacheHitRatePct))
      const cy = padTop + plotH - (pct / 100) * plotH
      return `${cx.toFixed(1)},${cy.toFixed(1)}`
    })
    .join(' ')

  const labelStep = series.length > 14 ? 5 : series.length > 8 ? 3 : 1

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      className="h-36 w-full overflow-hidden"
    >
      {/* 50% & 100% baseline hairlines */}
      <line
        x1={padX}
        y1={padTop}
        x2={width - padX}
        y2={padTop}
        stroke="rgb(var(--ink-border-soft))"
        strokeDasharray="3 3"
        strokeWidth="1"
      />
      <line
        x1={padX}
        y1={padTop + plotH / 2}
        x2={width - padX}
        y2={padTop + plotH / 2}
        stroke="rgb(var(--ink-border-soft))"
        strokeDasharray="3 3"
        strokeWidth="1"
      />
      <line
        x1={padX}
        y1={padTop + plotH}
        x2={width - padX}
        y2={padTop + plotH}
        stroke="rgb(var(--ink-border))"
        strokeWidth="1"
      />

      {series.map((b, i) => {
        const total = b.inputTokens + b.outputTokens
        const totalH = (total / maxTokens) * plotH
        const cacheH = (Math.min(total, b.cacheReadTokens) / maxTokens) * plotH
        const otherH = Math.max(0, totalH - cacheH)
        const x = padX + slotW * i + (slotW - barW) / 2
        const yCache = padTop + plotH - cacheH
        const yOther = yCache - otherH

        return (
          <g key={b.bucket}>
            <title>
              {`${b.label}: ${formatCompactTokens(total)} tok (${b.tokenCacheHitRatePct.toFixed(1)}% hit, ${formatUsd(b.costUsd)})`}
            </title>
            {otherH > 0 && (
              <rect
                x={x}
                y={yOther}
                width={barW}
                height={otherH}
                rx={1.5}
                fill="rgb(var(--ink-4))"
              />
            )}
            {cacheH > 0 && (
              <rect
                x={x}
                y={yCache}
                width={barW}
                height={cacheH}
                rx={1.5}
                fill="rgb(var(--c-ok) / 0.65)"
              />
            )}
            {(i % labelStep === 0 || i === series.length - 1) && (
              <text
                x={x + barW / 2}
                y={height - 4}
                textAnchor="middle"
                fill="rgb(var(--ink-fg-3))"
                fontSize="10"
                className="font-mono"
              >
                {b.label}
              </text>
            )}
          </g>
        )
      })}

      {series.length > 1 && (
        <polyline
          fill="none"
          stroke="rgb(var(--c-accent))"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={hitPoints}
        />
      )}
    </svg>
  )
}

export interface UsageDashboardSectionProps {
  variant?: 'settings' | 'dashboard'
}

export function UsageDashboardSection({
  variant = 'settings'
}: UsageDashboardSectionProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const isWeb = isWebBuild()
  const [range, setRange] = React.useState<LlmUsageRange>('7d')
  const [probeFilter, setProbeFilter] = React.useState<'all' | 'errors'>('all')
  const [clearing, setClearing] = React.useState(false)

  const { data, isLoading, isFetching, isError, refetch } = useLlmUsage(range, true)

  const summary = data?.summary
  const series = React.useMemo(() => data?.series ?? [], [data?.series])
  const bySurface = React.useMemo(() => data?.bySurface ?? [], [data?.bySurface])
  const byModel = React.useMemo(() => data?.byModel ?? [], [data?.byModel])
  const probeLogs = React.useMemo(() => {
    const raw = data?.probeLogs ?? []
    return probeFilter === 'errors' ? raw.filter((item) => !item.ok) : raw
  }, [data?.probeLogs, probeFilter])

  const handleClearProbeLogs = async (): Promise<void> => {
    if (isWeb || clearing) return
    setClearing(true)
    try {
      await clearLlmProbeLogs()
      await qc.invalidateQueries({ queryKey: ['llm', 'providers', 'usage'] })
      toastSuccess(t('settings.usageDashboard.probelog.cleared'))
    } catch (err) {
      toastError(t('settings.usageDashboard.probelog.clearFail'), errorMessage(err))
    } finally {
      setClearing(false)
    }
  }

  const totalCombinedTokens =
    (summary?.totalInputTokens ?? 0) + (summary?.outputTokens ?? 0)

  const rangeToolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label={t('settings.usageDashboard.rangeAria')}
        className="inline-flex rounded-md border border-ink-border-soft bg-ink-2 p-0.5"
      >
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={range === r}
            onClick={(): void => setRange(r)}
            className={cn(
              'rounded px-2.5 py-0.5 font-mono text-meta transition-colors',
              range === r
                ? 'bg-ink-4 font-medium text-ink-fg'
                : 'text-ink-fg-2 hover:text-ink-fg'
            )}
          >
            {r}
          </button>
        ))}
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={(): void => {
          void refetch()
        }}
        disabled={isFetching}
        aria-label={t('settings.usageDashboard.refreshAria')}
      >
        <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} aria-hidden="true" />
      </Button>
    </div>
  )

  const body = (
    <div className={cn('space-y-5', variant === 'settings' ? 'p-4' : 'pt-4')}>
      {variant === 'settings' && (
        <div className="flex flex-wrap items-center justify-between gap-2">{rangeToolbar}</div>
      )}
      {isLoading && !summary && (
        <div className="py-6 text-center text-aux text-ink-fg-2">
          {t('settings.usageDashboard.loading')}
        </div>
      )}

      {isError && !summary && (
        <div className="py-4 text-aux text-fail">
          {t('settings.usageDashboard.loadError')}
        </div>
      )}

      {summary && (
        <>
          {/* 4 KPI Cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-ink-border-soft bg-ink-2/70 px-3.5 py-3">
              <div className="text-aux text-ink-fg-2">
                {t('settings.usageDashboard.kpi.totalTokens')}
              </div>
              <div className="mt-1 font-mono text-title font-semibold tabular-nums text-ink-fg">
                {formatCompactTokens(totalCombinedTokens)}
              </div>
              <div className="mt-0.5 font-mono text-meta tabular-nums text-ink-fg-3">
                {`${formatCompactTokens(summary.totalInputTokens)} in · ${formatCompactTokens(summary.outputTokens)} out`}
              </div>
            </div>

            <div className="rounded-lg border border-ink-border-soft bg-ink-2/70 px-3.5 py-3">
              <div className="text-aux text-ink-fg-2">
                {t('settings.usageDashboard.kpi.cacheHitRate')}
              </div>
              <div className="mt-1 font-mono text-title font-semibold tabular-nums text-ok">
                {`${summary.tokenCacheHitRatePct.toFixed(1)}%`}
              </div>
              <div className="mt-0.5 font-mono text-meta tabular-nums text-ink-fg-3">
                {`${formatCompactTokens(summary.cacheReadTokens)} cached`}
              </div>
            </div>

            <div className="rounded-lg border border-ink-border-soft bg-ink-2/70 px-3.5 py-3">
              <div className="text-aux text-ink-fg-2">
                {t('settings.usageDashboard.kpi.estimatedCost')}
              </div>
              <div className="mt-1 font-mono text-title font-semibold tabular-nums text-ink-fg">
                {formatUsd(summary.estimatedCostUsd)}
              </div>
              <div className="mt-0.5 font-mono text-meta tabular-nums text-ink-fg-3">
                {`${summary.totalCalls} calls`}
              </div>
            </div>

            <div className="rounded-lg border border-ink-border-soft bg-ink-2/70 px-3.5 py-3">
              <div className="text-aux text-ink-fg-2">
                {t('settings.usageDashboard.kpi.cacheSaved')}
              </div>
              <div className="mt-1 font-mono text-title font-semibold tabular-nums text-ok">
                {formatUsd(summary.cacheSavedUsd)}
              </div>
              <div className="mt-0.5 font-mono text-meta tabular-nums text-ink-fg-3">
                {`${formatCompactTokens(summary.cacheWriteTokens)} write`}
              </div>
            </div>
          </div>

          {/* Trend SVG */}
          <div className="rounded-lg border border-ink-border-soft bg-ink-2/50 px-3.5 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-aux font-medium text-ink-fg">
                {t('settings.usageDashboard.chartTitle')}
              </span>
              <div className="flex items-center gap-3 text-aux text-ink-fg-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-ok/70" aria-hidden="true" />
                  {t('settings.usageDashboard.legendCacheRead')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-coral/80" aria-hidden="true" />
                  {t('settings.usageDashboard.legendHitRate')}
                </span>
              </div>
            </div>
            {summary.totalCalls === 0 ? (
              <div className="py-8 text-center text-aux text-ink-fg-3">
                {t('settings.usageDashboard.emptyRange')}
              </div>
            ) : (
              <UsageTrendChart
                series={series}
                ariaLabel={t('settings.usageDashboard.chartTitle')}
              />
            )}
          </div>

          {/* Breakdowns: By Surface & By Model */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-ink-border-soft bg-ink-2/50 p-3.5">
              <div className="mb-2.5 text-aux font-medium text-ink-fg">
                {t('settings.usageDashboard.bySurfaceTitle')}
              </div>
              {bySurface.length === 0 ? (
                <div className="py-3 text-aux text-ink-fg-3">
                  {t('settings.usageDashboard.emptyBreakdown')}
                </div>
              ) : (
                <div className="space-y-2">
                  {bySurface.map((row) => (
                    <div
                      key={row.surface}
                      className="flex items-center justify-between gap-2 rounded border border-ink-border-soft/70 bg-ink-2 px-2.5 py-1.5"
                    >
                      <span className="truncate text-aux text-ink-fg">
                        {t(`settings.usageDashboard.surfaces.${row.surface}`, {
                          defaultValue: row.surface
                        })}
                      </span>
                      <div className="flex shrink-0 items-center gap-2.5 font-mono text-meta tabular-nums text-ink-fg-2">
                        <span>{`${row.calls}×`}</span>
                        <span className="text-ok">{`${row.tokenCacheHitRatePct.toFixed(0)}%`}</span>
                        <span className="text-ink-fg">{formatUsd(row.costUsd)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-ink-border-soft bg-ink-2/50 p-3.5">
              <div className="mb-2.5 text-aux font-medium text-ink-fg">
                {t('settings.usageDashboard.byModelTitle')}
              </div>
              {byModel.length === 0 ? (
                <div className="py-3 text-aux text-ink-fg-3">
                  {t('settings.usageDashboard.emptyBreakdown')}
                </div>
              ) : (
                <div className="space-y-2">
                  {byModel.map((row) => {
                    const meta = lookupModelMeta(row.model, null)
                    return (
                      <div
                        key={`${row.providerId ?? 'none'}:${row.model}`}
                        className="flex items-center justify-between gap-2 rounded border border-ink-border-soft/70 bg-ink-2 px-2.5 py-1.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ProviderBrandIcon
                            providerId={row.providerId}
                            catalogProviderId={meta?.catalogProviderId}
                            className="size-4 shrink-0"
                          />
                          <span className="truncate font-mono text-meta text-ink-fg">
                            {row.model}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2.5 font-mono text-meta tabular-nums text-ink-fg-2">
                          <span>{`${row.calls}×`}</span>
                          <span className="text-ok">{`${row.tokenCacheHitRatePct.toFixed(0)}%`}</span>
                          <span className="text-ink-fg">{formatUsd(row.costUsd)}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Probe & Diagnostic Logs (latest 50) */}
      <div className="rounded-lg border border-ink-border-soft bg-ink-2/50 p-3.5">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-aux font-medium text-ink-fg">
            <Activity className="size-4 text-ink-fg-2" aria-hidden="true" />
            <span>{t('settings.usageDashboard.probelog.title')}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-ink-border-soft bg-ink-2 p-0.5">
              {(['all', 'errors'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={probeFilter === f}
                  onClick={(): void => setProbeFilter(f)}
                  className={cn(
                    'rounded px-2 py-0.5 text-aux transition-colors',
                    probeFilter === f
                      ? 'bg-ink-4 font-medium text-ink-fg'
                      : 'text-ink-fg-2 hover:text-ink-fg'
                  )}
                >
                  {t(`settings.usageDashboard.probelog.filter.${f}`)}
                </button>
              ))}
            </div>
            {!isWeb && (
              <Button
                size="sm"
                variant="ghost"
                disabled={clearing || (data?.probeLogs.length ?? 0) === 0}
                onClick={(): void => {
                  void handleClearProbeLogs()
                }}
              >
                <Trash2 className="mr-1 size-3.5" aria-hidden="true" />
                <span className="text-aux">{t('settings.usageDashboard.probelog.clear')}</span>
              </Button>
            )}
          </div>
        </div>

        {probeLogs.length === 0 ? (
          <div className="py-3 text-aux text-ink-fg-3">
            {t('settings.usageDashboard.probelog.empty')}
          </div>
        ) : (
          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {probeLogs.map((entry: LlmProbeLogEntry) => (
              <div
                key={entry.id}
                className="flex flex-col gap-0.5 rounded border border-ink-border-soft/60 bg-ink-2 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        entry.ok ? 'bg-ok' : 'bg-fail'
                      )}
                    />
                    <span className="font-mono text-meta text-ink-fg">
                      {entry.kind}
                    </span>
                    {entry.providerId && (
                      <span className="truncate font-mono text-meta text-ink-fg-2">
                        {entry.providerId}
                      </span>
                    )}
                    {entry.model && (
                      <span className="truncate font-mono text-meta text-ink-fg-3">
                        {entry.model}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 font-mono text-meta tabular-nums text-ink-fg-3">
                    {entry.latencyMs != null && <span>{`${entry.latencyMs}ms`}</span>}
                    <span>{formatIsoTimeAscii(entry.createdAt)}</span>
                  </div>
                </div>
                {entry.message && (
                  <div className="truncate text-aux text-ink-fg-2">{entry.message}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  if (variant === 'dashboard') {
    return (
      <section className="rounded-xl border border-ink-border-soft bg-ink-1 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-border-soft pb-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-body font-semibold text-ink-fg">
              {t('settings.usageDashboard.title')}
            </h2>
            <p className="mt-1 text-aux text-ink-fg-2">{t('settings.usageDashboard.helper')}</p>
          </div>
          {rangeToolbar}
        </div>
        {body}
      </section>
    )
  }

  return (
    <Section
      title={t('settings.usageDashboard.title')}
      helper={t('settings.usageDashboard.helper')}
    >
      {body}
    </Section>
  )
}
