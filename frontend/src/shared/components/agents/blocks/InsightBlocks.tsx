// Extracted from BlockRenderer.tsx — key points, callout, KOS context, action suggestion, and markdown blocks.

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'

import type {
  ReportActionSuggestionBlock,
  ReportCalloutBlock,
  ReportKeyPointsBlock,
  ReportKosContextBlock,
  ReportMarkdownBlock,
  ReportTone
} from '@shared/api/types'
import { type RenderCtx, mdLite, toneAlpha, toneColor } from '../lib'
import { ReportIcon } from '../primitives'

// ─── key_points ──────────────────────────────────────────────────────────────
export function KeyPointsBlock({
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
export function CalloutBlock({
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
export function KosContextBlock({
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
export function ActionSuggestionBlock({
  block
}: {
  block: ReportActionSuggestionBlock
}): React.ReactElement {
  const { t } = useTranslation()
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
        {t('agents.block.notExecutable')}
      </span>
    </div>
  )
}

// ─── general-purpose artifact blocks ───────────────────────────────────────
export function MarkdownBlock({ block }: { block: ReportMarkdownBlock }): React.ReactElement {
  return (
    <article
      className="break-words"
      style={{
        padding: '14px 16px',
        borderRadius: 12,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))',
        fontSize: 14,
        lineHeight: 1.65,
        color: 'rgb(var(--ink-fg-1))'
      }}
    >
      {block.title && (
        <h3
          style={{ fontSize: 14, fontWeight: 650, marginBottom: 10, color: 'rgb(var(--ink-fg))' }}
        >
          {block.title}
        </h3>
      )}
      <Streamdown mode="static" parseIncompleteMarkdown>
        {block.text}
      </Streamdown>
    </article>
  )
}
