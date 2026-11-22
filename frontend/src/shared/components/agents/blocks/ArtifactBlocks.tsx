// Extracted from BlockRenderer.tsx — timeline, checklist, progress, quote, metric delta, and image blocks.

import type React from 'react'
import type {
  ReportChecklistBlock,
  ReportImageBlock,
  ReportMetricDeltaBlock,
  ReportProgressBlock,
  ReportQuoteBlock,
  ReportTimelineBlock
} from '@shared/api/types'
import { ProgressiveImage } from '@shared/components/media/ProgressiveImage'
import { toneAlpha, toneColor } from '../lib'
import { ReportIcon } from '../primitives'

export function TimelineBlock({ block }: { block: ReportTimelineBlock }): React.ReactElement {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 12,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))'
      }}
    >
      {block.title && (
        <h3
          style={{ fontSize: 14, fontWeight: 650, color: 'rgb(var(--ink-fg))', marginBottom: 12 }}
        >
          {block.title}
        </h3>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {block.events.map((event, index) => {
          const tone = event.tone ?? 'neutral'
          return (
            <div
              key={`${event.time}-${index}`}
              style={{ display: 'grid', gridTemplateColumns: '76px 18px 1fr' }}
            >
              <time
                style={{
                  paddingTop: 1,
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 12,
                  color: 'rgb(var(--ink-fg-3))',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {event.time}
              </time>
              <span style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                {index < block.events.length - 1 && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 10,
                      bottom: -8,
                      width: 1,
                      background: 'rgb(var(--ink-border))'
                    }}
                  />
                )}
                <span
                  style={{
                    position: 'relative',
                    zIndex: 1,
                    width: 9,
                    height: 9,
                    marginTop: 4,
                    borderRadius: '50%',
                    background: tone === 'neutral' ? 'rgb(var(--ink-fg-3))' : toneColor(tone),
                    boxShadow: `0 0 0 3px ${tone === 'neutral' ? 'rgb(var(--ink-2))' : toneAlpha(tone, 0.14)}`
                  }}
                />
              </span>
              <div style={{ paddingBottom: index < block.events.length - 1 ? 16 : 0 }}>
                <div className="flex items-center" style={{ gap: 6 }}>
                  {event.icon && <ReportIcon name={event.icon} size={14} />}
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
                    {event.title}
                  </span>
                </div>
                {event.detail && (
                  <p
                    style={{
                      fontSize: 14,
                      lineHeight: 1.55,
                      color: 'rgb(var(--ink-fg-2))',
                      marginTop: 3
                    }}
                  >
                    {event.detail}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ChecklistBlock({ block }: { block: ReportChecklistBlock }): React.ReactElement {
  const done = block.items.filter((item) => item.done).length
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 12,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))'
      }}
    >
      <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
        {block.title && (
          <h3 style={{ fontSize: 14, fontWeight: 650, color: 'rgb(var(--ink-fg))' }}>
            {block.title}
          </h3>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))' }}>
          {done}/{block.items.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {block.items.map((item, index) => (
          <div key={index} className="flex items-start" style={{ gap: 9 }}>
            <span
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 18,
                height: 18,
                marginTop: 1,
                borderRadius: 5,
                color: item.done ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))',
                background: item.done ? 'rgb(var(--c-ok) / 0.12)' : 'rgb(var(--ink-fg) / 0.04)',
                border: `1px solid ${item.done ? 'rgb(var(--c-ok) / 0.35)' : 'rgb(var(--ink-border))'}`
              }}
            >
              {item.done && <ReportIcon name="check" size={12} />}
            </span>
            <span
              style={{
                fontSize: 14,
                lineHeight: 1.45,
                color: item.done ? 'rgb(var(--ink-fg-2))' : 'rgb(var(--ink-fg-1))',
                textDecoration: item.done ? 'line-through' : 'none'
              }}
            >
              {item.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProgressBlock({ block }: { block: ReportProgressBlock }): React.ReactElement {
  const max = block.max ?? 100
  const pct = Math.max(0, Math.min(100, (block.value / max) * 100))
  const tone = block.tone ?? 'info'
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 12,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))'
      }}
    >
      <div className="flex items-baseline" style={{ gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
          {block.label}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            color: toneColor(tone),
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {block.value}/{max}
        </span>
      </div>
      <div
        style={{
          height: 7,
          borderRadius: 8,
          background: 'rgb(var(--ink-fg) / 0.07)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 8,
            background: toneColor(tone),
            transition: 'width 220ms cubic-bezier(0.23,1,0.32,1)'
          }}
        />
      </div>
      {block.caption && (
        <p style={{ fontSize: 14, color: 'rgb(var(--ink-fg-2))', marginTop: 8, lineHeight: 1.45 }}>
          {block.caption}
        </p>
      )}
    </div>
  )
}

export function QuoteBlock({ block }: { block: ReportQuoteBlock }): React.ReactElement {
  return (
    <blockquote
      style={{
        margin: 0,
        padding: '13px 16px 13px 18px',
        borderRadius: 9,
        borderLeft: '3px solid rgb(var(--c-accent))',
        background: 'rgb(var(--ink-fg) / 0.035)'
      }}
    >
      <p style={{ fontSize: 15, lineHeight: 1.65, color: 'rgb(var(--ink-fg-1))' }}>{block.text}</p>
      {block.cite && (
        <footer style={{ fontSize: 14, color: 'rgb(var(--ink-fg-3))', marginTop: 8 }}>
          — {block.url ? <a href={block.url}>{block.cite}</a> : block.cite}
        </footer>
      )}
    </blockquote>
  )
}

export function MetricDeltaBlock({ block }: { block: ReportMetricDeltaBlock }): React.ReactElement {
  const positive = block.delta >= 0
  const tone = block.tone ?? (positive ? 'success' : 'warn')
  return (
    <div
      className="flex items-center"
      style={{
        gap: 14,
        padding: '13px 16px',
        borderRadius: 12,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))'
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: 'rgb(var(--ink-fg-2))' }}>{block.label}</div>
        <div style={{ fontSize: 24, fontWeight: 650, color: 'rgb(var(--ink-fg))', marginTop: 2 }}>
          {block.value}
        </div>
      </div>
      <span
        className="flex items-center"
        style={{ gap: 4, color: toneColor(tone), fontSize: 14, fontWeight: 600 }}
      >
        <ReportIcon name={positive ? 'chevronup' : 'chevrondown'} size={14} />
        {Math.abs(block.delta)}%
        {block.deltaLabel && (
          <span style={{ fontWeight: 400, color: 'rgb(var(--ink-fg-3))' }}>{block.deltaLabel}</span>
        )}
      </span>
    </div>
  )
}

export function ImageBlock({ block }: { block: ReportImageBlock }): React.ReactElement {
  return (
    <figure
      style={{
        margin: 0,
        padding: 10,
        borderRadius: 12,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))'
      }}
    >
      {/* Real load delay here: `src` is a report-authored /api, mailagent://, app:// or data:
          reference (src/reports/models.py is_internal_image_src) — non-data-URL forms round-trip
          through a local server/protocol handler, and there's no size/aspect-ratio known ahead of
          time, so a broken or slow image used to render as either nothing (still loading) or the
          browser's native broken-image glyph (failed) forever. */}
      <ProgressiveImage
        src={block.src}
        alt={block.alt ?? ''}
        containerStyle={{ width: '100%', maxWidth: block.width ?? '100%', minHeight: 160 }}
        containerClassName="mx-auto rounded-lg"
        imgStyle={{
          display: 'block',
          width: '100%',
          maxHeight: 560,
          objectFit: 'contain',
          margin: '0 auto'
        }}
        className="rounded-lg"
      />
      {block.caption && (
        <figcaption
          style={{ fontSize: 14, color: 'rgb(var(--ink-fg-3))', marginTop: 8, textAlign: 'center' }}
        >
          {block.caption}
        </figcaption>
      )}
    </figure>
  )
}
