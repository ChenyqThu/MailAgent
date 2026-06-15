/**
 * ReportMock — the /agents daily-digest view (report list rail + selected
 * report detail with overview + 5-stat row). Faithful recreation of the
 * reference .rep block (MailAgent.html + global.css .rep-*). Tier-2 mock.
 * Drives off fixtures.reportCards + fixtures.reportDetail.
 *
 * Presentational only — pure props → JSX, no product imports, no window.electron.
 */
import type { MockReportCard, MockReportDetail } from './fixtures/fixtures'
import { reportCards as defaultCards, reportDetail as defaultDetail } from './fixtures/fixtures'

export interface ReportMockProps {
  /** Report history cards (left rail). Defaults to fixtures.reportCards. */
  cards?: MockReportCard[]
  /** id of the selected card. */
  selectedId?: string
  /** Selected report's detail panel. Defaults to fixtures.reportDetail. */
  detail?: MockReportDetail
  locale?: 'zh-CN' | 'en'
}

interface Chrome {
  reports: string
  history: string
  ready: string
  mail: string
  urgent: string
  regenerate: string
}

const CHROME: Record<'zh-CN' | 'en', Chrome> = {
  'zh-CN': { reports: '报告', history: '历史报告', ready: '已就绪', mail: '封', urgent: '紧急', regenerate: '重新生成' },
  en: { reports: 'Reports', history: 'History', ready: 'Ready', mail: 'mail', urgent: 'urgent', regenerate: 'Regenerate' },
}

/** Coral sparkle star — the product brand mark. */
function Star({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  )
}

export default function ReportMock({
  cards = defaultCards,
  selectedId,
  detail = defaultDetail,
  locale = 'zh-CN',
}: ReportMockProps) {
  const t = CHROME[locale]
  const selId = selectedId ?? cards.find((c) => c.selected)?.id ?? cards[0]?.id

  return (
    <div className="rep" data-mock="ReportMock">
      {/* ── report list ────────────────────────────────────────────── */}
      <div className="rep-list">
        <div className="rep-tabs">
          <span className="off">Agents</span>
          <span className="on">
            {t.reports}
            <span className="badge">8</span>
          </span>
          <span className="off">Chats</span>
        </div>
        <div className="rep-h">{t.history}</div>
        {cards.map((c) => (
          <div key={c.id} className={`rep-card${c.id === selId ? ' sel' : ''}`}>
            <div className="rc1">
              <span>{c.date}</span>
              <span className="cad">{c.cadenceLabel}</span>
              <span className="ok">{c.status || t.ready}</span>
            </div>
            <div className="rtitle">{c.title}</div>
            <div className="rstat">
              <span>
                {c.mailCount} {t.mail}
              </span>
              <span className="crit">
                {c.urgentCount} {t.urgent}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* ── report detail ──────────────────────────────────────────── */}
      <div className="rep-detail">
        <div className="rep-dtop">
          <span className="pill">
            <span style={{ color: 'rgb(var(--c-accent))', display: 'inline-flex' }}>
              <Star size={12} />
            </span>
            {detail.cadenceLabel}
          </span>
          <span className="pill">{detail.model}</span>
          <span className="regen">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7 3.3M3 4v4h4" />
            </svg>
            {t.regenerate}
          </span>
        </div>
        <div className="rep-title">{detail.title}</div>
        <div className="rep-date">{detail.dateRange}</div>
        <div className="rep-over">{detail.overview}</div>
        <div className="rep-statrow">
          {detail.stats.map((s, i) => (
            <div key={s.key + i} className={`s${s.accent ? ' acc' : ''}`}>
              <div className="sv">{s.value}</div>
              <div className="sk">{s.key}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
