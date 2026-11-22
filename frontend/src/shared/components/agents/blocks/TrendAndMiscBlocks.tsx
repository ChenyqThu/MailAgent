// Extracted from BlockRenderer.tsx — trend bar chart, divider, and graceful unknown block fallback.

import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { ReportBlock, ReportTrendBlock } from '@shared/api/types'
import { type RenderCtx } from '../lib'
import { ReportIcon } from '../primitives'

// ─── trend — 纯 CSS 柱 ──────────────────────────────────────────────────────
export function TrendBlock({
  block,
  ctx
}: {
  block: ReportTrendBlock
  ctx: RenderCtx
}): React.ReactElement {
  const max = Math.max(...block.points.map((p) => p.value), 1)
  const delta = block.compare?.delta
  const variant = block.variant ?? 'bar'
  const chartWidth = 600
  const chartHeight = 112
  const points = block.points.map((point, index) => ({
    ...point,
    x:
      block.points.length === 1 ? chartWidth / 2 : (index / (block.points.length - 1)) * chartWidth,
    y: chartHeight - (point.value / max) * (chartHeight - 12)
  }))
  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ')
  return (
    <div
      style={{
        padding: ctx.dense ? '14px 16px' : '16px 18px',
        borderRadius: 10,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))'
      }}
    >
      <div className="flex items-center" style={{ gap: 8, marginBottom: 16 }}>
        <ReportIcon name="barchart" size={14} style={{ color: 'rgb(var(--ink-fg-2))' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
          {block.metric}
        </span>
        <span style={{ flex: 1 }} />
        {block.compare && delta !== undefined && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              fontWeight: 600,
              color: delta >= 0 ? 'rgb(var(--c-ok))' : 'rgb(var(--c-warn))'
            }}
          >
            <ReportIcon name={delta >= 0 ? 'chevronup' : 'chevrondown'} size={13} />
            {Math.abs(delta)}%{' '}
            <span style={{ fontWeight: 400, color: 'rgb(var(--ink-fg-3))' }}>
              {block.compare.label}
            </span>
          </span>
        )}
      </div>
      {variant !== 'bar' ? (
        <div style={{ position: 'relative', height: 142 }}>
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={block.metric}
            style={{ display: 'block', width: '100%', height: 112, overflow: 'visible' }}
          >
            {variant === 'area' && (
              <polygon
                points={`0,${chartHeight} ${polyline} ${chartWidth},${chartHeight}`}
                fill="rgb(var(--c-accent) / 0.12)"
              />
            )}
            <polyline
              points={polyline}
              fill="none"
              stroke="rgb(var(--c-accent))"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
            />
            {points.map((point, index) => (
              <circle
                key={index}
                cx={point.x}
                cy={point.y}
                r="4"
                fill="rgb(var(--ink-2))"
                stroke="rgb(var(--c-accent))"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          <div className="flex" style={{ justifyContent: 'space-between', gap: 6, marginTop: 7 }}>
            {points.map((point, index) => (
              <span
                key={index}
                style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))', textAlign: 'center' }}
              >
                {point.label}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 120 }}>
          {block.points.map((p, i) => {
            const h = Math.max(4, Math.round((p.value / max) * 100))
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  height: '100%',
                  justifyContent: 'flex-end'
                }}
              >
                <span
                  style={{
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 11,
                    color: 'rgb(var(--ink-fg-2))',
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {p.value}
                </span>
                <div
                  style={{
                    width: '100%',
                    maxWidth: 38,
                    height: `${h}%`,
                    borderRadius: '5px 5px 0 0',
                    // DESIGN 红线禁 gradient surface → 实色 coral（accent 是像素不是背景泛色）。
                    background: 'rgb(var(--c-accent))'
                  }}
                />
                <span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))', whiteSpace: 'nowrap' }}>
                  {p.label}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function DividerBlock(): React.ReactElement {
  return <div style={{ height: 1, background: 'rgb(var(--ink-border))', margin: '2px 0' }} />
}

export function UnknownBlock({ block }: { block: ReportBlock }): React.ReactElement {
  const { t } = useTranslation()
  const b = block as { type: string; text?: string; title?: string }
  return (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: 8,
        background: 'rgb(var(--ink-fg) / 0.03)',
        border: '1px dashed rgb(var(--ink-border))'
      }}
    >
      <div
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 11,
          color: 'rgb(var(--ink-fg-3))',
          marginBottom: 4
        }}
      >
        {t('agents.block.unknown', { type: b.type })}
      </div>
      {b.text && <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-1))' }}>{b.text}</div>}
      {b.title && <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-1))' }}>{b.title}</div>}
    </div>
  )
}
