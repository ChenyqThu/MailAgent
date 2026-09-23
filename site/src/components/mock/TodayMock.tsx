/**
 * TodayMock — the Today surface (今日). Recreates the product's TodaySurface
 * (frontend/src/shared/components/today/) at landing-page scale: date header
 * with the next hard point → "needs you" group (decisions with one approval
 * expanded inline, today's meetings, emails to answer grouped by thread) →
 * "up next" group (items due soon, agent output).
 *
 * Layout follows the mock's own width (container queries), not the viewport:
 *   ≥ 480px  full rows with secondary meta and the next-meeting chip beside the title
 *   < 480    chip drops under the title, secondary meta and row actions hide
 *
 * Presentational only — pure props → JSX, fictional data, no network.
 */
import type { CSSProperties, ReactNode } from 'react'
import './TodayMock.css'
import { todayMock, type TodayMockData, type TodayTone } from './fixtures/TodayMock'

export interface TodayMockProps {
  locale?: 'zh-CN' | 'en'
  /** Override the canned data (defaults to fixtures/TodayMock for the locale). */
  data?: TodayMockData
}

type IconName = 'bell' | 'calendar' | 'reply' | 'clock' | 'spark' | 'file' | 'chevron' | 'check'

function Icon({ name, size = 13 }: { name: IconName; size?: number }) {
  if (name === 'spark') {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
        <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
      </svg>
    )
  }
  const paths: Record<Exclude<IconName, 'spark'>, ReactNode> = {
    bell: (
      <>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>
    ),
    reply: (
      <>
        <path d="M9 17 4 12l5-5" />
        <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    file: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6M8 13h8M8 17h5" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    check: <path d="M20 6 9 17l-5-5" />,
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

function tone(t: TodayTone): CSSProperties {
  return { '--tone': `var(--c-${t})` } as CSSProperties
}

function SecHead({
  icon,
  t,
  title,
  count,
  meta,
}: {
  icon: IconName
  t: TodayTone
  title: string
  count: string
  meta?: string
}) {
  return (
    <div className="tdm-sechead" style={tone(t)}>
      <span className="tdm-sechead-ic">
        <Icon name={icon} size={12} />
      </span>
      <h4>{title}</h4>
      <span className="tdm-sechead-n">{count}</span>
      <span className="tdm-sechead-rule" aria-hidden="true" />
      {meta ? <span className="tdm-sechead-meta">{meta}</span> : null}
    </div>
  )
}

export default function TodayMock({ locale = 'zh-CN', data }: TodayMockProps) {
  const d = data ?? todayMock[locale]
  const c = d.chrome
  const run = d.decide.run

  return (
    <div className="tdm" data-mock="TodayMock">
      {/* ── header: date · title · next hard point ─────────────────────── */}
      <header className="tdm-head">
        <div className="tdm-head-main">
          <div className="tdm-kicker">
            <span>{c.kicker}</span>
            <span className="tdm-kicker-date">{c.date}</span>
          </div>
          <div className="tdm-title">{c.title}</div>
          <div className="tdm-subtitle">{c.subtitle}</div>
        </div>
        <div className="tdm-next">
          <div className="tdm-next-top">
            <Icon name="calendar" size={12} />
            <span className="tdm-next-label">{c.next.label}</span>
            <span className="tdm-next-left">{c.next.left}</span>
          </div>
          <div className="tdm-next-pending">{c.next.pending}</div>
        </div>
      </header>

      {/* ── needs you ─────────────────────────────────────────────────── */}
      <div className="tdm-group">{c.groupNeedYou}</div>

      <section className="tdm-sec">
        <SecHead icon="bell" t="ai" title={c.sections.decide.title} count={c.sections.decide.count} />
        <div className="tdm-rows">
          <div className="tdm-row open">
            <span className="tdm-agent" aria-hidden="true">
              <Icon name="spark" size={11} />
            </span>
            <span className="tdm-row-main">
              <span className="tdm-row-title">{run.agent}</span>
              <span className="tdm-row-sub">{run.trigger}</span>
            </span>
            <span className="tdm-row-age tdm-hide-narrow">{run.ago}</span>
          </div>
          <div className="tdm-approval">
            <div className="tdm-approval-head">
              <Icon name="bell" size={12} />
              <span>{c.approval.title}</span>
            </div>
            <p className="tdm-approval-body">{run.body}</p>
            <div className="tdm-preview">
              {run.preview.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
            <div className="tdm-approval-actions">
              <span className="tdm-btn primary">{c.approval.approve}</span>
              <span className="tdm-btn">{c.approval.editParams}</span>
              <span className="tdm-btn ghost">{c.approval.reject}</span>
            </div>
          </div>
          <div className="tdm-row">
            <span className="tdm-agent proposal" aria-hidden="true">
              <Icon name="file" size={12} />
            </span>
            <span className="tdm-row-main">
              <span className="tdm-row-title">{d.decide.proposal.title}</span>
              <span className="tdm-row-sub">
                {d.decide.proposal.matter}
                <span className="tdm-hide-narrow"> · {d.decide.proposal.meta}</span>
              </span>
            </span>
            <span className="tdm-chev">
              <Icon name="chevron" size={12} />
            </span>
          </div>
        </div>
      </section>

      <section className="tdm-sec">
        <SecHead icon="calendar" t="info" title={c.sections.meet.title} count={c.sections.meet.count} />
        <div className="tdm-rows">
          {d.meet.map((m) => (
            <div key={m.time} className={`tdm-row${m.soon ? ' soon' : ''}`}>
              <span className="tdm-time">{m.time}</span>
              <span className="tdm-row-main">
                <span className="tdm-row-title">{m.title}</span>
                <span className="tdm-row-sub">{m.sub}</span>
              </span>
              {m.soon ? <span className="tdm-link tdm-hide-narrow">{c.actions.openCalendar}</span> : null}
            </div>
          ))}
        </div>
      </section>

      <section className="tdm-sec">
        <SecHead
          icon="reply"
          t="accent"
          title={c.sections.reply.title}
          count={c.sections.reply.count}
          meta={c.replyMeta}
        />
        <div className="tdm-rows">
          {d.reply.map((r, i) => (
            <div key={r.subject} className="tdm-row">
              <span className="tdm-unread" aria-hidden="true" />
              <span className="tdm-row-main">
                <span className="tdm-row-title">
                  <span className="tdm-from">{r.from}</span>
                  <span className="tdm-subject">{r.subject}</span>
                </span>
                <span className="tdm-row-sub">{r.age}</span>
              </span>
              <span className="tdm-count">
                <Icon name="reply" size={10} />
                {r.count}
              </span>
              {i === 0 ? <span className="tdm-link tdm-hide-narrow">{c.actions.openMail}</span> : null}
            </div>
          ))}
        </div>
      </section>

      {/* ── up next ───────────────────────────────────────────────────── */}
      <div className="tdm-group">{c.groupNext}</div>

      <section className="tdm-sec">
        <SecHead icon="clock" t="urg" title={c.sections.due.title} count={c.sections.due.count} />
        <div className="tdm-rows">
          {d.due.map((m) => (
            <div key={m.id} className="tdm-row" style={tone(m.tone)}>
              <span className="tdm-mid">{m.id}</span>
              <span className="tdm-row-main">
                <span className="tdm-row-title">{m.title}</span>
              </span>
              <span className="tdm-due">
                <i aria-hidden="true" />
                {m.due}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="tdm-sec">
        <SecHead icon="spark" t="ai" title={c.sections.out.title} count={c.sections.out.count} />
        <div className="tdm-rows">
          {d.out.map((o) => (
            <div key={o.title} className="tdm-row">
              <span className="tdm-agent out" aria-hidden="true">
                <Icon name={o.kind === 'report' ? 'file' : 'spark'} size={o.kind === 'report' ? 12 : 11} />
              </span>
              <span className="tdm-row-main">
                <span className="tdm-row-title">{o.title}</span>
                <span className="tdm-row-sub">{o.why}</span>
              </span>
              {o.kind === 'report' ? (
                <span className="tdm-link tdm-hide-narrow">{c.actions.openReport}</span>
              ) : (
                <span className="tdm-chev">
                  <Icon name="chevron" size={12} />
                </span>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
