// Sprint 20 — 报告内 email_item 点击 → 溯源 slide-over。
// 展示 AI 字段（数据已在 block 内，无需额外取数）+ 两个溯源动作：
//   • 在 Notion 打开 → shell:openExternal(notion_url)
//   • 在收件箱打开 → setActive(id, navTarget) + 导航到 /（豁免 active-reset）
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'

import { useActiveEmail } from '@shared/state/active-email'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { priorityTone, fmtClock } from './lib'
import type { ReportEmailItemForPanel } from './lib'
import { Pip, ReportIcon } from './primitives'

// 内联按钮缺 :active 伪类 → 用 pointer 事件落地 press scale（DESIGN §9.3 / make-interfaces #12）。
// scale 0.97 ≥ 0.95 红线；调用方须在 style 里把 transform 列进 transition（含 transform，禁 transition:all）。
const PRESS_SCALE = 'scale(0.97)'

function openExternal(url: string): void {
  const w = window as unknown as {
    electron?: { ipcRenderer?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } }
  }
  const invoke = w.electron?.ipcRenderer?.invoke
  if (invoke) void invoke('shell:openExternal', url)
  else window.open(url, '_blank', 'noopener')
}

export function EmailSourcePanel({
  email,
  onClose
}: {
  email: ReportEmailItemForPanel | null
  onClose: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const setActive = useActiveEmail((s) => s.setActive)

  // 进/退场动效：遮罩与 aside 同步进退（syncBackdrop），退场对称、可中断、
  // 自动尊重 reduced-motion。open 由 email!==null
  // 驱动；退场期间 email→null，须保留最后一份非空 email 渲染，否则解构会崩。
  const open = email !== null
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: 'aside',
    from: { autoAlpha: 0, xPercent: 100 },
    syncBackdrop: true
  })
  const [shown, setShown] = useState<ReportEmailItemForPanel | null>(email)
  if (email && email !== shown) setShown(email)

  if (!shouldRender || !shown) return null

  const tone = priorityTone(shown.priority)
  const notionUrl = shown.source?.notion_url || null
  const avatar =
    (shown.sender_name || '?')
      .replace(/[^\p{L}\p{N}]/gu, '')
      .slice(0, 2)
      .toUpperCase() || '?'

  const openInbox = (): void => {
    setActive(shown.internal_id, { navTarget: true })
    void navigate({ to: '/' })
    onClose()
  }

  return (
    <div
      ref={scopeRef}
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgb(0 0 0 / 0.4)' }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 520,
          maxWidth: '92%',
          zIndex: 61,
          background: 'rgb(var(--ink-1))',
          borderLeft: '1px solid rgb(var(--ink-border))',
          boxShadow: 'var(--shadow-raised)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <header
          className="flex items-center"
          style={{
            gap: 10,
            padding: '15px 18px',
            borderBottom: '1px solid rgb(var(--ink-border-soft))',
            flexShrink: 0
          }}
        >
          <span style={{ color: 'rgb(var(--c-accent))', display: 'flex' }}>
            <ReportIcon name="mail" size={16} />
          </span>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
            {t('agents.source.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('agents.source.close')}
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
              color: 'rgb(var(--ink-fg-2))'
            }}
          >
            <ReportIcon name="x" size={16} />
          </button>
        </header>

        <div className="scrollbar-thin" style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <h3
                style={{
                  fontSize: 17,
                  fontWeight: 600,
                  color: 'rgb(var(--ink-fg))',
                  lineHeight: 1.3,
                  letterSpacing: '-0.01em'
                }}
              >
                {shown.subject || t('agents.source.noSubject')}
              </h3>
              <div className="flex items-center" style={{ gap: 8, marginTop: 9 }}>
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'rgb(var(--ink-fg-1))',
                    background: 'rgb(var(--ink-4))',
                    // #11 类图片方块用中性低透明描边（ink-fg/0.10 暗亮自动取中性黑白）。
                    border: '1px solid rgb(var(--ink-fg) / 0.10)'
                  }}
                >
                  {avatar}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
                    {shown.sender_name}
                  </div>
                  {shown.sender_addr && (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'rgb(var(--ink-fg-3))',
                        fontFamily: 'ui-monospace, monospace'
                      }}
                    >
                      {shown.sender_addr}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 12,
                    color: 'rgb(var(--ink-fg-3))'
                  }}
                >
                  {fmtClock(shown.time)}
                </span>
              </div>
            </div>

            {/* AI 字段 */}
            <div
              style={{
                borderRadius: 10,
                background: 'rgb(var(--ink-2))',
                border: '1px solid rgb(var(--ink-border))',
                overflow: 'hidden'
              }}
            >
              <div
                className="flex items-center"
                style={{
                  gap: 7,
                  padding: '9px 13px',
                  borderBottom: '1px solid rgb(var(--ink-border-soft))',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 11,
                  letterSpacing: '0.04em',
                  color: 'rgb(var(--ink-fg-2))'
                }}
              >
                <ReportIcon name="sparkles" size={12} style={{ color: 'rgb(var(--c-ai))' }} />
                {t('agents.source.aiFields')}
              </div>
              <div style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 11 }}>
                {shown.ai_summary && (
                  <div>
                    <div
                      style={{
                        fontFamily: 'ui-monospace, monospace',
                        fontSize: 10.5,
                        textTransform: 'uppercase',
                        color: 'rgb(var(--ink-fg-3))',
                        marginBottom: 4
                      }}
                    >
                      {t('agents.source.summary')}
                    </div>
                    <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'rgb(var(--ink-fg-1))' }}>
                      {shown.ai_summary}
                    </p>
                  </div>
                )}
                <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
                  {shown.priority && <Pip tone={tone}>{shown.priority}</Pip>}
                  {shown.category && <Pip tone="neutral">{shown.category}</Pip>}
                  {shown.ai_action && (
                    <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-2))' }}>
                      · {shown.ai_action}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer
          className="flex items-center"
          style={{
            gap: 9,
            padding: '13px 18px',
            borderTop: '1px solid rgb(var(--ink-border-soft))',
            flexShrink: 0
          }}
        >
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              color: 'rgb(var(--ink-fg-3))',
              flex: 1
            }}
          >
            #{shown.internal_id}
          </span>
          {notionUrl && (
            <button
              type="button"
              onClick={() => openExternal(notionUrl)}
              className="flex items-center"
              style={{
                gap: 6,
                fontFamily: 'inherit',
                fontSize: 13,
                padding: '8px 13px',
                borderRadius: 8,
                cursor: 'pointer',
                color: 'rgb(var(--ink-fg-1))',
                background: 'transparent',
                border: '1px solid rgb(var(--ink-border))',
                transition: 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
              }}
              onMouseDown={(e) => (e.currentTarget.style.transform = PRESS_SCALE)}
              onMouseUp={(e) => (e.currentTarget.style.transform = 'none')}
              onMouseLeave={(e) => (e.currentTarget.style.transform = 'none')}
            >
              <ReportIcon name="external" size={13} />
              {t('agents.source.openNotion')}
            </button>
          )}
          <button
            type="button"
            onClick={openInbox}
            className="flex items-center"
            style={{
              gap: 6,
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              padding: '8px 13px',
              borderRadius: 8,
              cursor: 'pointer',
              color: 'rgb(var(--c-accent-fg))',
              background: 'rgb(var(--c-accent-dim))',
              border: 0,
              transition:
                'background-color 120ms cubic-bezier(0.4,0,0.2,1), transform 120ms cubic-bezier(0.4,0,0.2,1)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgb(var(--c-accent))'
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.transform = PRESS_SCALE
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'none'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgb(var(--c-accent-dim))'
              e.currentTarget.style.transform = 'none'
            }}
          >
            <ReportIcon name="inbox" size={13} />
            {t('agents.source.openInbox')}
          </button>
        </footer>
      </aside>
    </div>
  )
}
