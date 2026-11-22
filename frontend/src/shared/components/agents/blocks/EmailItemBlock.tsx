// Extracted from BlockRenderer.tsx — expandable email item card & source link chrome.

import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReportEmailItemBlock } from '@shared/api/types'
import { type RenderCtx, fmtClock, priorityTone, toneColor } from '../lib'
import { Badge, Pip, ReportIcon } from '../primitives'

// ─── email_item ──────────────────────────────────────────────────────────────
export function EmailItemBlock({
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
            // #11 类图片方块用中性低透明描边（ink-fg/0.10 暗亮自动取中性黑白）。
            border: '1px solid rgb(var(--ink-fg) / 0.10)'
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
  const { t } = useTranslation()
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
      {label && <span>{t('agents.block.source')}</span>}
    </button>
  )
}
