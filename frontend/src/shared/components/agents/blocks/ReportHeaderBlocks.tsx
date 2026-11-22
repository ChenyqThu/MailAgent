// Extracted from BlockRenderer.tsx — header, overview, KPI stat row, and section heading blocks.

import type React from 'react'
import type {
  ReportHeaderBlock,
  ReportOverviewBlock,
  ReportSectionBlock,
  ReportStatRowBlock,
  ReportTone
} from '@shared/api/types'
import { type RenderCtx, mdLite, renderSummary, toneAlpha, toneColor } from '../lib'
import { ReportIcon } from '../primitives'

const SECTION_ICON: Record<string, string> = { alert: 'alert', check: 'checkcircle', info: 'info' }
const SECTION_TONE: Record<string, ReportTone> = {
  attention: 'critical',
  alert: 'critical',
  handled: 'success',
  check: 'success',
  fyi: 'neutral',
  info: 'neutral'
}

// ─── header ────────────────────────────────────────────────────────────────
export function HeaderBlock({
  block,
  ctx
}: {
  block: ReportHeaderBlock
  ctx: RenderCtx
}): React.ReactElement {
  const big = ctx.layout === 'document'
  return (
    <div style={{ marginBottom: big ? 26 : 18 }}>
      <div className="flex items-center" style={{ gap: 10, marginBottom: 8 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            display: 'grid',
            placeItems: 'center',
            background: 'rgb(var(--c-accent) / 0.14)',
            border: '1px solid rgb(var(--c-accent) / 0.30)',
            color: 'rgb(var(--c-accent))',
            flexShrink: 0
          }}
        >
          <ReportIcon name="sparkles" size={15} />
        </span>
        {block.date_label && (
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'rgb(var(--ink-fg-2))',
              padding: '3px 8px',
              borderRadius: 5,
              background: 'rgb(var(--ink-fg) / 0.04)',
              border: '1px solid rgb(var(--ink-border))'
            }}
          >
            {block.date_label}
          </span>
        )}
      </div>
      <h1
        style={{
          fontSize: big ? 30 : 24,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: 'rgb(var(--ink-fg))',
          lineHeight: 1.1
        }}
      >
        {block.title}
      </h1>
      {block.subtitle && (
        <p style={{ fontSize: 14, color: 'rgb(var(--ink-fg-2))', marginTop: 6 }}>
          {block.subtitle}
        </p>
      )}
    </div>
  )
}

// ─── overview ────────────────────────────────────────────────────────────────
export function OverviewBlock({
  block,
  ctx
}: {
  block: ReportOverviewBlock
  ctx: RenderCtx
}): React.ReactElement {
  const muted = (block.text || '').trim().startsWith('_')
  return (
    <p
      style={{
        fontSize: ctx.layout === 'document' ? 15.5 : 14.5,
        lineHeight: 1.75,
        color: muted ? 'rgb(var(--ink-fg-3))' : 'rgb(var(--ink-fg-1))',
        // 行宽跟容器: document 布局外层已有 720 居中容器管可读行长;
        // console 卡片里 stat_row/callout 等块全部撑满卡片宽, overview 单独
        // 限 680 会让第一段右缘明显窄于下方块 — 用户观感"摘要提前换行"
        // (dogfood round 3)。textWrap pretty 保留防孤字。
        textWrap: 'pretty'
      }}
    >
      {mdLite(block.text)}
    </p>
  )
}

// ─── stat_row ──────────────────────────────────────────────────────────────
export function StatRowBlock({
  block,
  ctx
}: {
  block: ReportStatRowBlock
  ctx: RenderCtx
}): React.ReactElement {
  if (ctx.layout === 'console') {
    return (
      <div className="flex items-stretch flex-wrap" style={{ gap: 8 }}>
        {block.stats.map((s) => (
          <div
            key={s.key}
            className="flex items-center"
            style={{
              gap: 9,
              padding: '7px 12px',
              borderRadius: 8,
              background: 'rgb(var(--ink-2))',
              border: '1px solid rgb(var(--ink-border))'
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 2,
                background: toneColor(s.tone),
                flexShrink: 0
              }}
            />
            <span
              style={{
                fontSize: 19,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                color: 'rgb(var(--ink-fg))',
                lineHeight: 1
              }}
            >
              {s.value}
            </span>
            <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))' }}>{s.label}</span>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${block.stats.length}, minmax(0,1fr))`,
        gap: 10
      }}
    >
      {block.stats.map((s) => {
        const accent = s.tone === 'critical' || s.tone === 'warn'
        return (
          <div
            key={s.key}
            style={{
              padding: ctx.dense ? '12px 12px' : '15px 14px',
              borderRadius: 10,
              background: accent ? toneAlpha(s.tone, 0.07) : 'rgb(var(--ink-2))',
              border: `1px solid ${accent ? toneAlpha(s.tone, 0.28) : 'rgb(var(--ink-border))'}`
            }}
          >
            <div
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'rgb(var(--ink-fg-2))',
                marginBottom: 7
              }}
            >
              {s.label}
            </div>
            <div
              style={{
                fontSize: 27,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
                color: accent ? toneColor(s.tone) : 'rgb(var(--ink-fg))'
              }}
            >
              {s.value}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── section header ──────────────────────────────────────────────────────────
export function SectionHeader({
  block,
  ctx
}: {
  block: ReportSectionBlock
  ctx: RenderCtx
}): React.ReactElement {
  const tone = SECTION_TONE[block.id] || SECTION_TONE[block.icon ?? ''] || 'neutral'
  const icon = SECTION_ICON[block.icon ?? ''] || block.icon || 'folder'
  if (ctx.layout === 'console') {
    return (
      <div className="flex items-center" style={{ gap: 9, marginBottom: 2 }}>
        <span style={{ color: toneColor(tone), display: 'flex' }}>
          <ReportIcon name={icon} size={15} />
        </span>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
          {block.title}
        </h2>
        {block.intro && (
          <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))' }}>· {block.intro}</span>
        )}
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 4 }}>
      <div className="flex items-center" style={{ gap: 10 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            background: toneAlpha(tone, 0.12),
            color: toneColor(tone)
          }}
        >
          <ReportIcon name={icon} size={15} />
        </span>
        <h2
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: 'rgb(var(--ink-fg))',
            letterSpacing: '-0.01em'
          }}
        >
          {block.title}
        </h2>
      </div>
      {block.intro && (
        <p style={{ fontSize: 13.5, color: 'rgb(var(--ink-fg-2))', marginTop: 6, marginLeft: 36 }}>
          {block.intro}
        </p>
      )}
    </div>
  )
}

// ─── section summary — 整体汇总 + 跳转链接 ─────────────────────────────────
export function SectionSummary({
  text,
  ctx
}: {
  text: string
  ctx: RenderCtx
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        gap: 9,
        alignItems: 'flex-start',
        marginLeft: ctx.layout === 'document' ? 36 : 0,
        marginBottom: ctx.layout === 'document' ? 2 : 4
      }}
    >
      <span
        style={{
          width: 3,
          alignSelf: 'stretch',
          borderRadius: 2,
          background: 'rgb(var(--c-accent) / 0.45)',
          flexShrink: 0,
          marginTop: 2,
          marginBottom: 2
        }}
      />
      <p
        style={{
          fontSize: ctx.dense ? 12.5 : 13.5,
          lineHeight: 1.65,
          color: 'rgb(var(--ink-fg-1))',
          textWrap: 'pretty'
        }}
      >
        {renderSummary(text, ctx.onJump)}
      </p>
    </div>
  )
}
