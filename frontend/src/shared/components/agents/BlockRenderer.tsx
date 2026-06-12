// Sprint 20 — BlockRenderer：渲染 ReportDoc.blocks[]（types.ts ReportBlock 契约）。
// 一 block 一组件；未知类型优雅降级。移植自 ~/Downloads/agents/blocks.jsx。
//
// 固定渲染：layout=console / rowStyle=list / aiSummary=hover / dense（用户定稿）。
// section 与其后续 email_item / callout / kos_context / action_suggestion 收拢进
// 一个 <section> 容器（console+list → 收件箱式行组）。
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ReportBlock,
  ReportCalloutBlock,
  ReportEmailItemBlock,
  ReportHeaderBlock,
  ReportKeyPointsBlock,
  ReportKosContextBlock,
  ReportActionSuggestionBlock,
  ReportOverviewBlock,
  ReportSectionBlock,
  ReportStatRowBlock,
  ReportTrendBlock,
  ReportTone
} from '@shared/api/types'
import {
  type RenderCtx,
  mdLite,
  priorityTone,
  renderSummary,
  scrollToEmail,
  toneAlpha,
  toneColor,
  fmtClock
} from './lib'
import { Badge, Pip, ReportIcon } from './primitives'

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
function HeaderBlock({
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
function OverviewBlock({
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
function StatRowBlock({
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
function SectionHeader({
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
function SectionSummary({ text, ctx }: { text: string; ctx: RenderCtx }): React.ReactElement {
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

// ─── email_item ──────────────────────────────────────────────────────────────
function EmailItemBlock({
  block,
  ctx
}: {
  block: ReportEmailItemBlock
  ctx: RenderCtx
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  const tone = priorityTone(block.priority)
  const showSummary = ctx.aiSummary === 'inline' || hover
  const badges = block.badges || []
  const pad = ctx.dense ? '9px 12px' : '13px 14px'
  const avatarInitials =
    (block.sender_name || '?')
      .replace(/[^\p{L}\p{N}]/gu, '')
      .slice(0, 2)
      .toUpperCase() ||
    block.sender_name?.slice(0, 1) ||
    '?'

  if (ctx.rowStyle === 'list') {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => ctx.onOpenEmail(block)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') ctx.onOpenEmail(block)
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        id={`email-${block.internal_id}`}
        style={{
          position: 'relative',
          display: 'block',
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          padding: pad,
          paddingLeft: 16,
          borderRadius: 0,
          borderBottom: '1px solid rgb(var(--ink-border-soft))',
          background: hover ? 'rgb(var(--ink-fg) / 0.025)' : 'transparent',
          transition: 'background 120ms'
        }}
      >
        {tone !== 'neutral' && (
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 6,
              bottom: 6,
              width: 3,
              borderRadius: 2,
              background: toneColor(tone)
            }}
          />
        )}
        <div className="flex items-baseline" style={{ gap: 8 }}>
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: 'rgb(var(--ink-fg))',
              flexShrink: 0,
              maxWidth: 130,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {block.sender_name}
          </span>
          <span
            style={{
              fontSize: 13.5,
              color: 'rgb(var(--ink-fg-1))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0
            }}
          >
            {block.subject}
          </span>
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              color: 'rgb(var(--ink-fg-3))',
              flexShrink: 0
            }}
          >
            {fmtClock(block.time)}
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 8, marginTop: 4 }}>
          {block.priority && <Pip tone={tone}>{block.priority}</Pip>}
          {block.category && (
            <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-2))' }}>{block.category}</span>
          )}
          {block.ai_action && (
            <span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))' }}>· {block.ai_action}</span>
          )}
          <span style={{ flex: 1 }} />
          {badges.map((b) => (
            <Badge key={b}>{b}</Badge>
          ))}
          <SourceLink onClick={(e) => openSource(e, block, ctx)} />
        </div>
        {showSummary && block.ai_summary && (
          <p
            style={{
              fontSize: 12.5,
              color: 'rgb(var(--ink-fg-1))',
              marginTop: 5,
              lineHeight: 1.55,
              display: 'flex',
              gap: 6
            }}
          >
            <ReportIcon
              name="sparkles"
              size={11}
              style={{ color: 'rgb(var(--c-ai))', flexShrink: 0, marginTop: 3 }}
            />
            <span>{block.ai_summary}</span>
          </p>
        )}
      </div>
    )
  }

  // card style
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => ctx.onOpenEmail(block)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') ctx.onOpenEmail(block)
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      id={`email-${block.internal_id}`}
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        padding: pad,
        borderRadius: 10,
        overflow: 'hidden',
        background: 'rgb(var(--ink-2))',
        border: `1px solid ${hover ? 'rgb(var(--ink-border))' : 'rgb(var(--ink-border-soft))'}`,
        boxShadow: hover ? 'var(--shadow-raised)' : 'none',
        transition: 'box-shadow 120ms, border-color 120ms'
      }}
    >
      {tone === 'critical' && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: toneColor('critical')
          }}
        />
      )}
      <div className="flex" style={{ gap: 11 }}>
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
            fontWeight: 600,
            color: 'rgb(var(--ink-fg-1))',
            background: 'rgb(var(--ink-4))',
            border: '1px solid rgb(var(--ink-border))'
          }}
        >
          {avatarInitials}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-baseline" style={{ gap: 8 }}>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'rgb(var(--ink-fg))',
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {block.subject}
            </span>
            <span
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: 11,
                color: 'rgb(var(--ink-fg-3))',
                flexShrink: 0
              }}
            >
              {fmtClock(block.time)}
            </span>
          </div>
          <div className="flex items-center" style={{ gap: 7, marginTop: 3 }}>
            <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-1))' }}>
              {block.sender_name}
            </span>
            {block.sender_addr && (
              <span
                style={{
                  fontSize: 11.5,
                  color: 'rgb(var(--ink-fg-3))',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {block.sender_addr}
              </span>
            )}
          </div>
          {showSummary && block.ai_summary && (
            <p
              style={{
                fontSize: 12.5,
                color: 'rgb(var(--ink-fg-1))',
                marginTop: 8,
                lineHeight: 1.55,
                display: 'flex',
                gap: 6,
                padding: '7px 9px',
                background: 'rgb(var(--c-ai) / 0.07)',
                borderRadius: 7,
                border: '1px solid rgb(var(--c-ai) / 0.15)'
              }}
            >
              <ReportIcon
                name="sparkles"
                size={11}
                style={{ color: 'rgb(var(--c-ai))', flexShrink: 0, marginTop: 3 }}
              />
              <span>{block.ai_summary}</span>
            </p>
          )}
          <div className="flex items-center flex-wrap" style={{ gap: 6, marginTop: 9 }}>
            {block.priority && <Pip tone={tone}>{block.priority}</Pip>}
            {block.category && <Pip tone="neutral">{block.category}</Pip>}
            {badges.map((b) => (
              <Badge key={b}>{b}</Badge>
            ))}
            <span style={{ flex: 1 }} />
            {block.ai_action && (
              <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-2))', fontWeight: 500 }}>
                {block.ai_action}
              </span>
            )}
            <SourceLink onClick={(e) => openSource(e, block, ctx)} label />
          </div>
        </div>
      </div>
    </div>
  )
}

function openSource(e: React.MouseEvent, block: ReportEmailItemBlock, ctx: RenderCtx): void {
  e.stopPropagation()
  ctx.onOpenEmail(block)
}

function SourceLink({
  onClick,
  label
}: {
  onClick: (e: React.MouseEvent) => void
  label?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11.5,
        color: 'rgb(var(--ink-fg-2))',
        background: 'transparent',
        border: 0,
        cursor: 'pointer',
        padding: '2px 4px',
        borderRadius: 4,
        fontFamily: 'inherit'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'rgb(var(--c-accent))'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'rgb(var(--ink-fg-2))'
      }}
    >
      <ReportIcon name="external" size={11} />
      {label && <span>溯源</span>}
    </button>
  )
}

// ─── key_points ──────────────────────────────────────────────────────────────
function KeyPointsBlock({
  block,
  ctx
}: {
  block: ReportKeyPointsBlock
  ctx: RenderCtx
}): React.ReactElement {
  return (
    <div
      style={{
        padding: ctx.dense ? '14px 16px' : '16px 18px',
        borderRadius: 10,
        background: 'rgb(var(--ink-1))',
        border: '1px solid rgb(var(--ink-border-soft))'
      }}
    >
      {block.title && (
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'rgb(var(--ink-fg))',
            marginBottom: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 7
          }}
        >
          <ReportIcon name="zap" size={13} style={{ color: 'rgb(var(--c-accent))' }} />
          {block.title}
        </div>
      )}
      <ul style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {block.items.map((it, i) => (
          <li
            key={i}
            style={{
              display: 'flex',
              gap: 9,
              fontSize: 13.5,
              lineHeight: 1.55,
              color: 'rgb(var(--ink-fg-1))'
            }}
          >
            <span
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: 11,
                color: 'rgb(var(--c-accent))',
                flexShrink: 0,
                marginTop: 2,
                fontWeight: 600
              }}
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <span style={{ textWrap: 'pretty' }}>{mdLite(it)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── callout ──────────────────────────────────────────────────────────────────
function CalloutBlock({
  block,
  ctx
}: {
  block: ReportCalloutBlock
  ctx: RenderCtx
}): React.ReactElement {
  const tone: ReportTone =
    block.tone === 'warn' ? 'warn' : block.tone === 'critical' ? 'critical' : 'info'
  const ic = tone === 'critical' ? 'alert' : tone === 'warn' ? 'alertcircle' : 'info'
  return (
    <div
      style={{
        display: 'flex',
        gap: 11,
        padding: ctx.dense ? '9px 14px' : '14px 16px',
        borderRadius: 10,
        background: toneAlpha(tone, 0.08),
        border: `1px solid ${toneAlpha(tone, 0.28)}`
      }}
    >
      <span style={{ color: toneColor(tone), flexShrink: 0, marginTop: 1 }}>
        <ReportIcon name={ic} size={16} />
      </span>
      <div>
        {block.title && (
          <div style={{ fontSize: 13, fontWeight: 600, color: toneColor(tone), marginBottom: 3 }}>
            {block.title}
          </div>
        )}
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.6,
            color: 'rgb(var(--ink-fg-1))',
            textWrap: 'pretty'
          }}
        >
          {mdLite(block.body)}
        </div>
      </div>
    </div>
  )
}

// ─── kos_context ──────────────────────────────────────────────────────────────
function KosContextBlock({
  block,
  ctx
}: {
  block: ReportKosContextBlock
  ctx: RenderCtx
}): React.ReactElement {
  return (
    <div
      style={{
        padding: ctx.dense ? '12px 14px' : '14px 16px',
        borderRadius: 10,
        position: 'relative',
        background: 'rgb(var(--c-ai) / 0.06)',
        border: '1px solid rgb(var(--c-ai) / 0.22)'
      }}
    >
      <div className="flex items-center" style={{ gap: 8, marginBottom: 7 }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            background: 'rgb(var(--c-ai) / 0.16)',
            color: 'rgb(var(--c-ai))',
            flexShrink: 0
          }}
        >
          <ReportIcon name="database" size={13} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
          {block.title}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 10,
            letterSpacing: '0.04em',
            padding: '2px 6px',
            borderRadius: 4,
            color: 'rgb(var(--c-ai))',
            background: 'rgb(var(--c-ai) / 0.12)',
            border: '1px solid rgb(var(--c-ai) / 0.25)'
          }}
        >
          {block.source}
        </span>
      </div>
      <p
        style={{ fontSize: 13, lineHeight: 1.6, color: 'rgb(var(--ink-fg-1))', textWrap: 'pretty' }}
      >
        {block.snippet}
      </p>
      <div
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 11,
          color: 'rgb(var(--ink-fg-3))',
          marginTop: 8
        }}
      >
        {block.entity_slug}
      </div>
    </div>
  )
}

// ─── action_suggestion (v1 禁用态) ───────────────────────────────────────────
function ActionSuggestionBlock({
  block
}: {
  block: ReportActionSuggestionBlock
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '11px 14px',
        borderRadius: 10,
        background: 'rgb(var(--ink-1))',
        border: '1px dashed rgb(var(--ink-border))'
      }}
    >
      <span style={{ color: 'rgb(var(--ink-fg-3))', flexShrink: 0 }}>
        <ReportIcon name="zap" size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg-1))' }}>
          {block.title}
        </div>
        {block.detail && (
          <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
            {block.detail}
          </div>
        )}
      </div>
      <span
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 10,
          color: 'rgb(var(--ink-fg-3))',
          padding: '2px 6px',
          borderRadius: 4,
          background: 'rgb(var(--ink-fg) / 0.04)'
        }}
      >
        v1 暂不可执行
      </span>
    </div>
  )
}

// ─── trend — 纯 CSS 柱 ──────────────────────────────────────────────────────
function TrendBlock({
  block,
  ctx
}: {
  block: ReportTrendBlock
  ctx: RenderCtx
}): React.ReactElement {
  const max = Math.max(...block.points.map((p) => p.value), 1)
  const delta = block.compare?.delta
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
                  background:
                    'linear-gradient(to top, rgb(var(--c-accent) / 0.55), rgb(var(--c-accent)))'
                }}
              />
              <span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))', whiteSpace: 'nowrap' }}>
                {p.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DividerBlock(): React.ReactElement {
  return <div style={{ height: 1, background: 'rgb(var(--ink-border))', margin: '2px 0' }} />
}

function UnknownBlock({ block }: { block: ReportBlock }): React.ReactElement {
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
        未知块 · {b.type}
      </div>
      {b.text && <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-1))' }}>{b.text}</div>}
      {b.title && <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-1))' }}>{b.title}</div>}
    </div>
  )
}

// 非 section/email_item 的独立 block 分发。ReportUnknownBlock 的 type:string 让判别式
// 收窄保留它，故各 case 显式 cast（运行时已按 type 命中，cast 安全）。
function renderLeaf(block: ReportBlock, key: number, ctx: RenderCtx): React.ReactElement {
  switch (block.type) {
    case 'header':
      return <HeaderBlock key={key} block={block as ReportHeaderBlock} ctx={ctx} />
    case 'overview':
      return <OverviewBlock key={key} block={block as ReportOverviewBlock} ctx={ctx} />
    case 'stat_row':
      return <StatRowBlock key={key} block={block as ReportStatRowBlock} ctx={ctx} />
    case 'key_points':
      return <KeyPointsBlock key={key} block={block as ReportKeyPointsBlock} ctx={ctx} />
    case 'callout':
      return <CalloutBlock key={key} block={block as ReportCalloutBlock} ctx={ctx} />
    case 'kos_context':
      return <KosContextBlock key={key} block={block as ReportKosContextBlock} ctx={ctx} />
    case 'action_suggestion':
      return <ActionSuggestionBlock key={key} block={block as ReportActionSuggestionBlock} />
    case 'trend':
      return <TrendBlock key={key} block={block as ReportTrendBlock} ctx={ctx} />
    case 'divider':
      return <DividerBlock key={key} />
    default:
      return <UnknownBlock key={key} block={block} />
  }
}

const _SECTION_CHILDREN = new Set(['email_item', 'callout', 'kos_context', 'action_suggestion'])

// ─── section group — 折叠容器 ────────────────────────────────────────────────
// 默认折叠：报告默认呈"摘要视图"（header + 汇总一句话 + 邮件数/重点数），长邮件
// 列表按需展开，不被海量 FYI/已处理刷屏。summary 折叠态保留（它是浓缩结论，不是
// 长列表）；email 列表只在展开时渲染。
function SectionGroup({
  sec,
  items,
  ctx,
  expanded,
  onToggle
}: {
  sec: ReportSectionBlock
  items: ReportBlock[]
  ctx: RenderCtx
  expanded: boolean
  onToggle: () => void
}): React.ReactElement {
  const collapsed = !expanded
  const groupedList = ctx.rowStyle === 'list' && ctx.layout === 'console'
  const emails = items.filter((it) => it.type === 'email_item') as ReportEmailItemBlock[]
  const total = emails.length
  // 简单统计：priority 非 neutral（紧急 / 重要）的封数 —— 该组里值得优先看的"重点"数。
  const flagged = emails.filter((e) => priorityTone(e.priority) !== 'neutral').length
  // 有邮件列表才折叠；纯文字概述的 section（周 / 月报 email_refs 留空）无列表可展开，
  // 直接常显，不挂无效的展开箭头。
  const collapsible = total > 0

  const headerBody = (
    <>
      <div style={{ flex: 1, minWidth: 0 }}>
        <SectionHeader block={sec} ctx={ctx} />
      </div>
      {collapsible && (
        <>
          <span
            style={{
              fontSize: 12,
              color: 'rgb(var(--ink-fg-2))',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {total} 封{flagged > 0 ? ` · ${flagged} 重点` : ''}
          </span>
          <ReportIcon
            name={collapsed ? 'chevrondown' : 'chevronup'}
            size={16}
            style={{ color: 'rgb(var(--ink-fg-3))', flexShrink: 0 }}
          />
        </>
      )}
    </>
  )

  return (
    <section
      style={{ display: 'flex', flexDirection: 'column', gap: ctx.layout === 'document' ? 12 : 8 }}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            fontFamily: 'inherit'
          }}
        >
          {headerBody}
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>{headerBody}</div>
      )}
      {sec.summary && <SectionSummary text={sec.summary} ctx={ctx} />}
      {collapsible && !collapsed && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: groupedList ? 0 : ctx.dense ? 8 : 10,
            ...(groupedList
              ? {
                  border: '1px solid rgb(var(--ink-border-soft))',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: 'rgb(var(--ink-1))'
                }
              : {})
          }}
        >
          {items.map((it, k) =>
            it.type === 'email_item' ? (
              <EmailItemBlock key={k} block={it as ReportEmailItemBlock} ctx={ctx} />
            ) : (
              renderLeaf(it, k, ctx)
            )
          )}
        </div>
      )}
    </section>
  )
}

// 把 blocks[] 折成"段"（命令式扫描的结果）：section 组 / 顶层 callout 组 / 顶层 leaf。
// 与原 while 扫描语义逐字对齐，仅把结果物化成数据（再 map 渲染）。key 仍是各段起始索引 i。
type RenderSegment =
  | { kind: 'section'; key: number; sec: ReportSectionBlock; items: ReportBlock[] }
  | { kind: 'callout-group'; key: number; group: ReportBlock[] }
  | { kind: 'leaf'; key: number; block: ReportBlock }

interface BlockLayout {
  segments: RenderSegment[]
  // email_item internal_id → 所属 section 段的 key（仅 section 内 email_item；顶层 email_item 不入表）。
  emailToSection: Map<number, number>
}

function planBlocks(blocks: ReportBlock[]): BlockLayout {
  const segments: RenderSegment[] = []
  const emailToSection = new Map<number, number>()
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]
    if (b.type === 'section') {
      const sec = b as ReportSectionBlock
      const items: ReportBlock[] = []
      let j = i + 1
      while (j < blocks.length && _SECTION_CHILDREN.has(blocks[j].type)) {
        const child = blocks[j]
        items.push(child)
        if (child.type === 'email_item') {
          emailToSection.set((child as ReportEmailItemBlock).internal_id, i)
        }
        j++
      }
      segments.push({ kind: 'section', key: i, sec, items })
      i = j
    } else if (b.type === 'callout') {
      // 连续顶层 callout 收成一组，组内间距收紧（"几个核心"成组陈列，而非松散卡片）。
      const group: ReportBlock[] = []
      let j = i
      while (j < blocks.length && blocks[j].type === 'callout') {
        group.push(blocks[j])
        j++
      }
      segments.push({ kind: 'callout-group', key: i, group })
      i = j
    } else {
      segments.push({ kind: 'leaf', key: i, block: b })
      i++
    }
  }
  return { segments, emailToSection }
}

export function BlockRenderer({
  blocks,
  ctx
}: {
  blocks: ReportBlock[]
  ctx: RenderCtx
}): React.ReactElement {
  const gap = ctx.dense ? 12 : 16

  // 受控折叠态：key = section 段起始索引（planBlocks 里的 i）。空集 = 全折叠（保持现状默认）。
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [pendingScrollId, setPendingScrollId] = useState<number | null>(null)

  const { segments, emailToSection } = useMemo(() => planBlocks(blocks), [blocks])

  const handleToggle = useCallback((key: number) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])

  // 跳转包装：目标 email 在某折叠 section 内 → 先展开该 section（受控），再排队滚动。
  // 顶层 / 无映射的 email_item 锚点本就在 DOM，直接排队滚动即可。
  const handleJump = useCallback(
    (id: number) => {
      const secKey = emailToSection.get(id)
      if (secKey != null) {
        setExpanded((s) => {
          if (s.has(secKey)) return s
          const n = new Set(s)
          n.add(secKey)
          return n
        })
      }
      setPendingScrollId(id)
    },
    [emailToSection]
  )

  // DOM commit 后再滚动：依赖 expanded 让"展开 section 引发的重渲染"提交后才执行，
  // 此时目标 email_item 锚点已挂载 → getElementById 命中（不靠 rAF 猜时序）。
  // 滚动后清 pendingScrollId（响应"展开 commit"这一异步信号、做一次性副作用），
  // 是 effect 的合理用法；render 期间替代会改写 ref/触 react-hooks/refs。React Compiler 迁移债。
  useEffect(() => {
    if (pendingScrollId == null) return
    scrollToEmail(pendingScrollId)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingScrollId(null)
  }, [pendingScrollId, expanded])

  // 给 section 及其子块的 ctx 覆盖 onJump（SectionSummary 直接读 ctx.onJump）。
  const childCtx = useMemo(() => ({ ...ctx, onJump: handleJump }), [ctx, handleJump])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {segments.map((seg) => {
        if (seg.kind === 'section') {
          return (
            <SectionGroup
              key={seg.key}
              sec={seg.sec}
              items={seg.items}
              ctx={childCtx}
              expanded={expanded.has(seg.key)}
              onToggle={() => handleToggle(seg.key)}
            />
          )
        }
        if (seg.kind === 'callout-group') {
          return (
            <div key={seg.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {seg.group.map((c, k) => renderLeaf(c, k, childCtx))}
            </div>
          )
        }
        if (seg.block.type === 'email_item') {
          return (
            <EmailItemBlock
              key={seg.key}
              block={seg.block as ReportEmailItemBlock}
              ctx={childCtx}
            />
          )
        }
        return renderLeaf(seg.block, seg.key, childCtx)
      })}
    </div>
  )
}
