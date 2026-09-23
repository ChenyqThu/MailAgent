/**
 * MatterMock — a matter's detail page (事项). Recreates the product's matter
 * detail (frontend/src/shared/components/matters/) at landing-page scale:
 * header (id, title, status, health, due, tags) → main column (background and
 * goal, completion criteria with progress, action items: one dispatched to an
 * agent and running, one waiting on a person, one done) → side column (core
 * stakeholders, progress grouped by day, a follow-up agent proposal waiting
 * for review).
 *
 * Layout follows the mock's own width (container queries), not the viewport:
 *   ≥ 900px  two columns, 320px side column
 *   641–899  two columns, narrower side column; background/goal stack
 *   ≤ 640    single column, side column hidden
 *
 * Presentational only — pure props → JSX, fictional data, no network.
 */
import type { CSSProperties, ReactNode } from 'react'
import './MatterMock.css'
import { matterMock, type MatterMockData, type MatterTone } from './fixtures/MatterMock'

export interface MatterMockProps {
  locale?: 'zh-CN' | 'en'
  /** Override the canned data (defaults to fixtures/MatterMock for the locale). */
  data?: MatterMockData
}

function Svg({ size, children }: { size: number; children: ReactNode }) {
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
      {children}
    </svg>
  )
}

const CheckIcon = ({ size = 10 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
)
const CalendarIcon = () => (
  <Svg size={12}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </Svg>
)
const MailIcon = () => (
  <Svg size={10}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </Svg>
)
const Spark = ({ size = 11 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
  </svg>
)

function tone(t: MatterTone): CSSProperties {
  return { '--tone': `var(--c-${t})` } as CSSProperties
}

function Mono({ initials, t }: { initials: string; t: MatterTone }) {
  return (
    <span className="mtm-mono" style={tone(t)} aria-hidden="true">
      {initials}
    </span>
  )
}

function SecHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mtm-sechead">
      <h4>{title}</h4>
      <span className="mtm-sechead-rule" aria-hidden="true" />
      {right}
    </div>
  )
}

export default function MatterMock({ locale = 'zh-CN', data }: MatterMockProps) {
  const d = data ?? matterMock[locale]
  const c = d.chrome
  const m = d.matter
  const done = d.criteria.filter((x) => x.done).length
  const pct = Math.round((done / d.criteria.length) * 100)

  return (
    <div className="mtm" data-mock="MatterMock">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <header className="mtm-head">
        <div className="mtm-head-meta">
          <span className="mtm-id">{m.id}</span>
          <span className="mtm-pill" style={tone('info')}>
            <i aria-hidden="true" />
            {m.status}
          </span>
          <span className="mtm-pill" style={tone('warn')}>
            <i aria-hidden="true" />
            {m.health}
          </span>
          <span className="mtm-due">
            <CalendarIcon />
            {m.due}
          </span>
        </div>
        <div className="mtm-title">{m.title}</div>
        <div className="mtm-tags">
          {m.tags.map((tag) => (
            <span key={tag} className="mtm-tag">
              #{tag}
            </span>
          ))}
        </div>
      </header>

      <div className="mtm-body">
        {/* ── main column ─────────────────────────────────────────────── */}
        <div className="mtm-main">
          <section className="mtm-state">
            <div className="mtm-state-block">
              <div className="mtm-lab">{c.background}</div>
              <p>{d.background}</p>
            </div>
            <div className="mtm-state-block">
              <div className="mtm-lab">{c.goal}</div>
              <p>{d.goal}</p>
            </div>
          </section>

          <section>
            <SecHead title={c.criteria} right={<span className="mtm-sechead-n">{c.criteriaCount}</span>} />
            <div className="mtm-progress" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </div>
            <ul className="mtm-checks">
              {d.criteria.map((x) => (
                <li key={x.text} className={x.done ? 'done' : undefined}>
                  <span className="mtm-box" aria-hidden="true">
                    {x.done ? <CheckIcon /> : null}
                  </span>
                  <span>{x.text}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <SecHead title={c.actions} right={<span className="mtm-sechead-n">{d.actions.length}</span>} />
            <ul className="mtm-items">
              {d.actions.map((item) => (
                <li key={item.title} className={`mtm-item ${item.state}`}>
                  <span className="mtm-item-mark" aria-hidden="true">
                    {item.state === 'done' ? <CheckIcon size={10} /> : null}
                    {item.state === 'agent' ? <Spark size={10} /> : null}
                  </span>
                  <span className="mtm-item-main">
                    <span className="mtm-item-title">{item.title}</span>
                    <span className="mtm-item-meta">{item.meta}</span>
                  </span>
                  <span className="mtm-item-state">
                    {item.state !== 'done' ? <i aria-hidden="true" /> : null}
                    {item.stateLabel}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* ── side column ─────────────────────────────────────────────── */}
        <aside className="mtm-aside">
          <section>
            <SecHead title={c.stakeholders} />
            <div className="mtm-tier">{c.core}</div>
            <ul className="mtm-people">
              {d.stakeholders.map((p) => (
                <li key={p.name}>
                  <Mono initials={p.initials} t={p.tone} />
                  <span className="mtm-person">
                    <span className="mtm-person-name">{p.name}</span>
                    <span className="mtm-person-sub">
                      {p.role} · {p.org}
                    </span>
                  </span>
                  {p.waiting ? (
                    <span className="mtm-waiting">
                      <i aria-hidden="true" />
                      {p.waiting}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <SecHead title={c.progress} />
            <div className="mtm-days">
              {d.progress.map((day) => (
                <div key={day.day} className="mtm-day">
                  <div className="mtm-day-label">{day.day}</div>
                  <ol>
                    {day.items.map((it) => (
                      <li key={it.text} style={tone(it.tone)}>
                        <span className="mtm-kind">{it.kind}</span>
                        <span className="mtm-entry">
                          <span className="mtm-entry-text">{it.text}</span>
                          <span className="mtm-entry-meta">
                            {it.time}
                            {it.ref ? (
                              <span className="mtm-ref">
                                <MailIcon />
                                {it.ref}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </section>

          <section className="mtm-proposal">
            <div className="mtm-proposal-head">
              <span className="mtm-proposal-ic">
                <Spark size={11} />
              </span>
              <span className="mtm-proposal-who">{c.followup}</span>
              <span className="mtm-proposal-meta">{d.proposal.meta}</span>
            </div>
            <div className="mtm-proposal-title">{d.proposal.title}</div>
            <p className="mtm-proposal-sum">{d.proposal.summary}</p>
            <div className="mtm-proposal-actions">
              <span className="mtm-btn ghost">{d.proposal.reject}</span>
              <span className="mtm-btn primary">{d.proposal.accept}</span>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
