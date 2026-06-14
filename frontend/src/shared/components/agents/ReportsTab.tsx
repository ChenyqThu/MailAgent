// Sprint 20 — 报告 tab：master 列表（cadence 过滤 + 状态徽标）+ 详情（BlockRenderer
// + generating/failed/empty 态）。窄屏单栏 + 返回栈。移植自 ~/Downloads/agents/reports.jsx。
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Trash2, X } from 'lucide-react'

import type { ReportCadence, ReportListItem } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { ShimmerText } from '@shared/components/ShimmerText'
import { BlockRenderer } from './BlockRenderer'
import { EmailSourcePanel } from './EmailSourcePanel'
import { CadencePill, ReportIcon, StatusBadge } from './primitives'
import {
  FIXED_RENDER,
  fmtClock,
  scrollToEmail,
  type RenderCtx,
  type ReportEmailItemForPanel
} from './lib'
import { useDeleteReport, useNarrow, useReport, useReportList, useRunNow } from './hooks'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const CADENCE_FILTERS: Array<[string, string]> = [
  ['all', '全部'],
  ['daily', '日报'],
  ['weekly', '周报'],
  ['monthly', '月报']
]

// ─── master 列表行 ───────────────────────────────────────────────────────────
function ReportListRow({
  item,
  selected,
  onClick,
  onDelete
}: {
  item: ReportListItem
  selected: boolean
  onClick: () => void
  onDelete: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const weekday = (() => {
    const d = new Date(item.report_date)
    return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()]
  })()
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onClick}
        style={{
          position: 'relative',
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '11px 36px 11px 16px',
          borderRadius: 9,
          cursor: 'pointer',
          fontFamily: 'inherit',
          // 主题 v2 — 选中卡片 ink 实底转半透 (玻璃下死色块割裂)。
          background: selected ? 'rgb(var(--ink-fg) / 0.07)' : 'transparent',
          border: `1px solid ${selected ? 'var(--hairline-strong)' : 'transparent'}`,
          transition: 'background 120ms'
        }}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.background = 'rgb(var(--ink-fg) / 0.03)'
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.background = 'transparent'
        }}
      >
        {selected && (
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 8,
              bottom: 8,
              width: 3,
              borderRadius: 2,
              background: 'rgb(var(--c-accent))'
            }}
          />
        )}
        <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'rgb(var(--ink-fg))',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {item.report_date.slice(5).replace('-', '/')}
          </span>
          <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>{weekday}</span>
          <CadencePill cadence={item.cadence} />
          <span style={{ flex: 1 }} />
          <StatusBadge status={item.status} />
        </div>
        <p
          style={{
            fontSize: 13,
            color: 'rgb(var(--ink-fg-1))',
            lineHeight: 1.45,
            textWrap: 'pretty',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {item.headline}
        </p>
        {item.status === 'ready' && item.counts && (
          <div
            className="flex items-center"
            style={{
              gap: 8,
              marginTop: 7,
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              color: 'rgb(var(--ink-fg-3))'
            }}
          >
            <span>{item.counts.total ?? 0} 封</span>
            {(item.counts.urgent ?? 0) > 0 && (
              <>
                <span>·</span>
                <span style={{ color: 'rgb(var(--c-crit))' }}>{item.counts.urgent} 紧急</span>
              </>
            )}
            {(item.counts.replied ?? 0) > 0 && (
              <>
                <span>·</span>
                <span style={{ color: 'rgb(var(--c-ok))' }}>{item.counts.replied} 已回复</span>
              </>
            )}
          </div>
        )}
      </button>
      {/* 删除：hover 露出垃圾桶 → 点一下进确认（✓/✗），与 SessionsPage 同款 */}
      {confirming ? (
        <span className="absolute top-2 right-2 flex items-center gap-0.5">
          <button
            type="button"
            aria-label={t('chat.sidebar.deleteConfirm')}
            onClick={(e) => {
              e.stopPropagation()
              setConfirming(false)
              onDelete()
            }}
            className="p-1.5 rounded bg-fail/15 text-fail hover:bg-fail/25 transition-colors duration-fast"
          >
            <Check size={13} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            aria-label={t('chat.sidebar.deleteCancel')}
            onClick={(e) => {
              e.stopPropagation()
              setConfirming(false)
            }}
            className="p-1.5 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
          >
            <X size={13} strokeWidth={2.5} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          aria-label={t('chat.sidebar.delete')}
          title={t('chat.sidebar.delete')}
          onClick={(e) => {
            e.stopPropagation()
            setConfirming(true)
          }}
          className={cn(
            'absolute top-2 right-2 p-1.5 rounded',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            'transition-opacity duration-fast',
            'text-ink-fg-3 hover:text-fail hover:bg-fail/10'
          )}
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

function ReportList({
  items,
  selectedId,
  onSelect,
  onDelete,
  filter,
  onFilter,
  fluid,
  loading
}: {
  items: ReportListItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  filter: string
  onFilter: (f: string) => void
  fluid?: boolean
  loading: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        width: fluid ? '100%' : 332,
        flexShrink: 0,
        borderRight: fluid ? 'none' : '1px solid rgb(var(--ink-border))',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        // 主题 v2 — 列表面板透到页面玻璃底, 不画 ink 实底 (割裂)。
        background: 'transparent'
      }}
    >
      <div
        style={{
          padding: '14px 14px 10px',
          borderBottom: '1px solid rgb(var(--ink-border-soft))',
          flexShrink: 0
        }}
      >
        <div className="flex items-center" style={{ gap: 8, marginBottom: 11 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
            {t('agents.reports.history')}
          </h2>
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              color: 'rgb(var(--ink-fg-3))'
            }}
          >
            {items.length}
          </span>
        </div>
        {/* v0.7.2 — 统一 SegmentedControl（视觉与原 .seg + .on 一致 + 滑动指示器）。 */}
        <SegmentedControl
          value={filter}
          onChange={onFilter}
          ariaLabel={t('agents.reports.history')}
          fluid
          className="w-full"
          options={CADENCE_FILTERS.map(([k]) => ({ value: k, label: t(`agents.cadence.${k}`) }))}
        />
      </div>
      <div className="scrollbar-thin" style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
        {loading && items.length === 0 ? (
          <div style={{ padding: '24px 14px', fontSize: 13, color: 'rgb(var(--ink-fg-3))' }}>
            {t('agents.reports.loading')}
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: '24px 14px', fontSize: 13, color: 'rgb(var(--ink-fg-3))' }}>
            {t('agents.reports.none')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {items.map((it) => (
              <ReportListRow
                key={it.id}
                item={it}
                selected={it.id === selectedId}
                onClick={() => onSelect(it.id)}
                onDelete={() => onDelete(it.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 详情态 ─────────────────────────────────────────────────────────────────
function GeneratingState(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <div className="flex items-center" style={{ gap: 10 }}>
        <span className="spin" style={{ color: 'rgb(var(--c-info))', display: 'flex' }}>
          <ReportIcon name="loader" size={18} />
        </span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          <ShimmerText text={t('agents.reports.generating')} neutral />
        </span>
      </div>
      <p style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))' }}>
        {t('agents.reports.generatingHint')}
      </p>
      {[80, 100, 60].map((w, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="shimmer" style={{ height: 14, width: `${w * 0.4}%`, borderRadius: 5 }} />
          <div className="shimmer" style={{ height: 64, width: '100%', borderRadius: 10 }} />
        </div>
      ))}
    </div>
  )
}

function FailedState({
  error,
  onRetry,
  retrying
}: {
  error: string | null
  onRetry: () => void
  retrying: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        maxWidth: 520,
        margin: '60px auto 0',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14
      }}
    >
      <span
        style={{
          width: 52,
          height: 52,
          borderRadius: 13,
          display: 'grid',
          placeItems: 'center',
          background: 'rgb(var(--c-fail) / 0.12)',
          color: 'rgb(var(--c-fail))'
        }}
      >
        <ReportIcon name="alert" size={24} />
      </span>
      <div>
        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
          {t('agents.reports.failed')}
        </h3>
        <p style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginTop: 6 }}>
          {error || t('agents.reports.failedHint')}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="flex items-center"
        style={{
          gap: 7,
          padding: '8px 16px',
          borderRadius: 8,
          fontFamily: 'inherit',
          fontSize: 13.5,
          fontWeight: 500,
          cursor: retrying ? 'wait' : 'pointer',
          color: 'rgb(var(--c-accent))',
          background: 'rgb(var(--c-accent) / 0.10)',
          border: '1px solid rgb(var(--c-accent) / 0.30)'
        }}
      >
        <span className={retrying ? 'spin' : undefined} style={{ display: 'flex' }}>
          <ReportIcon name="refresh" size={14} />
        </span>
        {t('agents.reports.regenerate')}
      </button>
    </div>
  )
}

function EmptyState({ total }: { total: number }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        maxWidth: 460,
        margin: '70px auto 0',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14
      }}
    >
      <span
        style={{
          width: 52,
          height: 52,
          borderRadius: 13,
          display: 'grid',
          placeItems: 'center',
          background: 'rgb(var(--ink-3))',
          color: 'rgb(var(--ink-fg-3))'
        }}
      >
        <ReportIcon name="checkcircle" size={24} />
      </span>
      <div>
        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
          {t('agents.reports.empty')}
        </h3>
        <p style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginTop: 6, lineHeight: 1.55 }}>
          {t('agents.reports.emptyHint', { count: total })}
        </p>
      </div>
    </div>
  )
}

function ReportDetailView({
  item,
  ctx,
  onRetry,
  retrying
}: {
  item: ReportListItem
  ctx: RenderCtx
  onRetry: () => void
  retrying: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const { report, isLoading } = useReport(item.id)
  const status = item.status
  // console（定稿）→ 详情全宽，与 Agents/Chats tab 一致（消除右侧留白）；
  // document（长文阅读模式，当前未启用）→ 720 居中。空态/失败态各自内部已居中限宽。
  const docLayout = ctx.layout === 'document'

  return (
    <div className="scrollbar-thin" style={{ flex: 1, overflowY: 'auto', height: '100%' }}>
      {report?.doc && status === 'ready' && (
        <div
          className="flex items-center"
          // 主题 v2 — sticky 概要栏走 group-header 同款配方: --glass-base
          // 派生 (与窗口 tint 同源, 换 accent 自动跟) 替代 ink-0 死色 +
          // blur(8px) (非浮层去 blur 红线); 遮字靠高 alpha 叠 body tint。
          style={{
            gap: 10,
            padding: '10px 24px',
            borderBottom: '1px solid var(--hairline)',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11,
            color: 'rgb(var(--ink-fg-3))',
            position: 'sticky',
            top: 0,
            zIndex: 5,
            background: 'color-mix(in srgb, var(--glass-base) 92%, transparent)'
          }}
        >
          <CadencePill cadence={report.doc.cadence} />
          {report.doc.model && <span>{report.doc.model}</span>}
          <span>·</span>
          <span>
            {t('agents.reports.generatedAt')} {fmtClock(report.doc.generated_at)}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="flex items-center"
            style={{
              gap: 5,
              fontFamily: 'inherit',
              fontSize: 12,
              color: 'rgb(var(--ink-fg-2))',
              background: 'transparent',
              border: 0,
              cursor: retrying ? 'wait' : 'pointer'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'rgb(var(--c-accent))'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'rgb(var(--ink-fg-2))'
            }}
          >
            <span className={retrying ? 'spin' : undefined} style={{ display: 'flex' }}>
              <ReportIcon name="refresh" size={12} />
            </span>
            {t('agents.reports.regenerate')}
          </button>
        </div>
      )}
      <div style={{ padding: ctx.dense ? '20px 24px 60px' : '28px 24px 60px' }}>
        <div style={docLayout ? { maxWidth: 720, margin: '0 auto' } : undefined}>
          {status === 'generating' && <GeneratingState />}
          {status === 'failed' && (
            <FailedState error={item.error} onRetry={onRetry} retrying={retrying} />
          )}
          {status === 'empty' && <EmptyState total={item.counts?.total ?? 0} />}
          {status === 'ready' &&
            (isLoading ? (
              <GeneratingState />
            ) : report?.doc ? (
              <BlockRenderer blocks={report.doc.blocks} ctx={ctx} />
            ) : (
              <EmptyState total={item.counts?.total ?? 0} />
            ))}
        </div>
      </div>
    </div>
  )
}

// ─── tab ────────────────────────────────────────────────────────────────────
export function ReportsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<string>('all')
  const cadence = filter === 'all' ? undefined : (filter as ReportCadence)
  const { items, isLoading } = useReportList(cadence)
  // 用户显式点选；派生有效选中（pick 仍在列表→用它，否则回落第一份），免 set-state-in-effect。
  const [picked, setPicked] = useState<string | null>(null)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [sourceEmail, setSourceEmail] = useState<ReportEmailItemForPanel | null>(null)
  const narrow = useNarrow()
  const { run, isRunning } = useRunNow()
  const { remove } = useDeleteReport()
  // 删除当前选中项时，refetch 后 picked 不再命中 → selected 自动回落第一份（派生逻辑）。
  const onDelete = (id: string): void => {
    void remove(id)
  }

  const selected = useMemo(() => {
    if (picked) {
      const hit = items.find((it) => it.id === picked)
      if (hit) return hit
    }
    return items[0] ?? null
  }, [items, picked])
  const selectedId = selected?.id ?? null

  const ctx: RenderCtx = useMemo(
    () => ({
      ...FIXED_RENDER,
      onOpenEmail: (block) => setSourceEmail(block as ReportEmailItemForPanel),
      onJump: (id) => scrollToEmail(id)
    }),
    []
  )

  const onSelect = (id: string): void => {
    setPicked(id)
    if (narrow) setMobileDetail(true)
  }
  const onRetry = (): void => {
    if (selected && !isRunning) void run(selected.agent_id, { cadence: selected.cadence })
  }

  const detail = selected ? (
    <ReportDetailView item={selected} ctx={ctx} onRetry={onRetry} retrying={isRunning} />
  ) : (
    <div
      className="flex items-center"
      style={{ flex: 1, justifyContent: 'center', color: 'rgb(var(--ink-fg-3))', fontSize: 13 }}
    >
      {isLoading ? t('agents.reports.loading') : t('agents.reports.selectHint')}
    </div>
  )

  // 溯源面板 scope 到本 tab 的相对容器。
  const panel = <EmailSourcePanel email={sourceEmail} onClose={() => setSourceEmail(null)} />

  if (narrow) {
    return (
      <div style={{ position: 'relative', height: '100%', width: '100%' }}>
        {mobileDetail && selected ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <button
              type="button"
              onClick={() => setMobileDetail(false)}
              className="flex items-center"
              style={{
                gap: 6,
                padding: '10px 16px',
                borderBottom: '1px solid var(--hairline)',
                fontFamily: 'inherit',
                fontSize: 13,
                color: 'rgb(var(--ink-fg-1))',
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                flexShrink: 0
              }}
            >
              <ReportIcon name="chevronleft" size={15} />
              {t('agents.reports.backToList')}
            </button>
            {detail}
          </div>
        ) : (
          <ReportList
            items={items}
            selectedId={selectedId}
            onSelect={onSelect}
            onDelete={onDelete}
            filter={filter}
            onFilter={setFilter}
            loading={isLoading}
            fluid
          />
        )}
        {panel}
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', display: 'flex', height: '100%', minHeight: 0 }}>
      <ReportList
        items={items}
        selectedId={selectedId}
        onSelect={onSelect}
        onDelete={onDelete}
        filter={filter}
        onFilter={setFilter}
        loading={isLoading}
      />
      {detail}
      {panel}
    </div>
  )
}
