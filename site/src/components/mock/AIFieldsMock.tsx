/**
 * AIFieldsMock — the AI FIELDS panel.
 *
 *  - variant 'panel' (default): the in-email AI FIELDS card with a draft-card
 *    (summary · reply-suggestion draft with blinking caret · Send/Redo/Edit ·
 *    priority/action/category footer). Faithful to the reference AI Fields split
 *    (.aif + .draftcard, MailAgent.html + global.css).
 *  - variant 'proof': the Provenance read-only field-row card
 *    (Summary/Priority/Category/Counts[code-filled badge]/Source links) used in
 *    the anti-hallucination block (.proof-card + .field-row).
 *
 * Tier-2 mock. Drives off fixtures.aiFields.
 * Presentational only — pure props → JSX, no product imports, no window.electron.
 */
import type { ReactNode } from 'react'
import type { MockAIFields, Priority } from './fixtures/fixtures'
import { aiFields as defaultAiFields } from './fixtures/fixtures'

export interface AIFieldsMockProps {
  /** AI fields data. Defaults to fixtures.aiFields. */
  fields?: MockAIFields
  /**
   * Render variant:
   *  - 'panel' (default): the in-email AI FIELDS card with draft-card.
   *  - 'proof': the Provenance field-row list (Summary/Priority/Category/
   *             Counts[code-filled]/Source) used in the anti-hallucination block.
   */
  variant?: 'panel' | 'proof'
  /** Animate the draft caret (respects prefers-reduced-motion). */
  animateCaret?: boolean
  locale?: 'zh-CN' | 'en'
}

/** Map fixture priority → the .ppip / .pip modifier class (low → norm). */
function priClass(p: Priority): string {
  return p === 'low' ? 'norm' : p
}

/** Coral sparkle star — the product brand mark. */
function Star({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  )
}

/** Render a draft string, turning `backtick` spans into <code> (matches the
 *  reference's inline <code>update</code> styling when a fixture marks one). */
function renderDraft(draft: string): ReactNode[] {
  return draft.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      <span key={i}>{part}</span>
    ),
  )
}

interface Chrome {
  reviewed: string
  summary: string
  replySuggestion: string
  draftAwaiting: string
  send: string
  redo: string
  edit: string
  priority: string
  action: string
  category: string
  counts: string
  source: string
  countsValue: string
}

const CHROME: Record<'zh-CN' | 'en', Chrome> = {
  'zh-CN': {
    reviewed: 'reviewed',
    summary: 'Summary',
    replySuggestion: 'Reply Suggestion',
    draftAwaiting: '草稿 · 待你确认',
    send: '发送',
    redo: '重写',
    edit: '编辑',
    priority: 'Priority',
    action: 'Action',
    category: 'Category',
    counts: 'Counts',
    source: 'Source',
    countsValue: '9 未读 · 总计 674',
  },
  en: {
    reviewed: 'reviewed',
    summary: 'Summary',
    replySuggestion: 'Reply Suggestion',
    draftAwaiting: 'Draft · awaiting you',
    send: 'Send',
    redo: 'Redo',
    edit: 'Edit',
    priority: 'Priority',
    action: 'Action',
    category: 'Category',
    counts: 'Counts',
    source: 'Source',
    countsValue: '9 unread · 674 total',
  },
}

export default function AIFieldsMock({
  fields = defaultAiFields,
  variant = 'panel',
  animateCaret = true,
  locale = 'zh-CN',
}: AIFieldsMockProps) {
  const t = CHROME[locale]

  if (variant === 'proof') {
    return (
      <div className="proof-card" data-mock="AIFieldsMock" data-variant="proof">
        <div className="pc-top">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 3l7 4v5c0 4-3 7-7 8-4-1-7-4-7-8V7l7-4z" />
          </svg>
          AI Fields · 5
          <span className="reviewed">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            {t.reviewed}
          </span>
        </div>
        <div className="pc-body">
          <div className="field-row">
            <span className="fk">{t.summary}</span>
            <span className="fv">{fields.summary}</span>
          </div>
          <div className="field-row">
            <span className="fk">{t.priority}</span>
            <span className="fv">
              <span className={`tag-pip pip-${priClass(fields.priority)}`} style={{ fontSize: 11 }}>
                <span className="d" />
                {fields.priorityLabel}
              </span>
            </span>
          </div>
          <div className="field-row">
            <span className="fk">{t.category}</span>
            <span className="fv">{fields.category}</span>
          </div>
          <div className="field-row">
            <span className="fk">{t.counts}</span>
            <span className="fv">
              <span className="badge-code">code-filled</span>
              &nbsp; <span style={{ color: 'rgb(var(--ink-fg-2))' }}>{t.countsValue}</span>
            </span>
          </div>
          <div className="field-row">
            <span className="fk">{t.source}</span>
            <span className="fv">
              <span className="src">notion.so/…830d80cb ↗</span> ·{' '}
              <span className="src">{locale === 'en' ? 'open in app ↗' : '打开邮件 ↗'}</span>
            </span>
          </div>
        </div>
      </div>
    )
  }

  // variant === 'panel'
  return (
    <div className="aif" data-mock="AIFieldsMock" data-variant="panel">
      <div className="aif-top">
        <span className="star">
          <Star size={13} />
        </span>{' '}
        AI Fields · 5{' '}
        <span className="rev">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {t.reviewed}
        </span>
        <span className="model">{fields.model}</span>
      </div>
      <div className="aif-sec">
        <div className="aif-lab">
          <span className="n">✶</span> {t.summary}
        </div>
        <div className="aif-sum">{fields.summary}</div>
      </div>
      <div className="aif-sec">
        <div className="aif-lab">
          <span className="n">✶</span> {t.replySuggestion}
        </div>
        <div className="draftcard">
          <div className="dc-top">
            <Star size={11} />
            {t.draftAwaiting}
          </div>
          <div className="dc-body">
            {renderDraft(fields.draft)}
            {animateCaret ? <span className="caret" /> : null}
          </div>
          <div className="dc-act">
            <button className="dc-send">{t.send}</button>
            <button className="dc-ghost">↺ {t.redo}</button>
            <button className="dc-ghost">✎ {t.edit}</button>
          </div>
        </div>
      </div>
      <div className="aif-foot">
        <span className="ff">
          <span className="fk">{t.priority}</span>
          <span className={`ppip ${priClass(fields.priority)}`}>{fields.priorityLabel}</span>
        </span>
        <span className="ff">
          <span className="fk">{t.action}</span>
          {fields.action}
        </span>
        <span className="ff">
          <span className="fk">{t.category}</span>
          {fields.category}
        </span>
      </div>
    </div>
  )
}
