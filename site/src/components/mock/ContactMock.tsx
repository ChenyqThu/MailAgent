/**
 * ContactMock — the Contacts person page (通讯录人物档案). Recreates the
 * product's ContactDetail + ContactProfileCard + ContactOrgSection
 * (frontend/src/shared/components/contacts/) at landing-page scale:
 * dossier header (monogram, display + formal name, role line, email anchors,
 * exchange stats) → AI profile card (summary with evidence badges, topics,
 * shared projects, month-level trajectory) → reporting line (manager card +
 * derived colleague chips).
 *
 * Layout follows the mock's own width (container queries), not the viewport:
 *   ≥ 680px  narrow contact list with names on the left
 *   440–679  list collapses to a monogram rail
 *   < 440    list hidden, detail only
 *
 * Presentational only — pure props → JSX, fictional data, no network.
 */
import type { CSSProperties } from 'react'
import './ContactMock.css'
import {
  contactMock,
  type ContactEvidence,
  type ContactMockData,
  type MonoTone,
  type ProfileRun,
} from './fixtures/ContactMock'

export interface ContactMockProps {
  locale?: 'zh-CN' | 'en'
  /** Override the canned data (defaults to fixtures/ContactMock for the locale). */
  data?: ContactMockData
}

function Mono({ initials, tone, size }: { initials: string; tone: MonoTone; size: number }) {
  const style = {
    '--mono': `var(--c-${tone})`,
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.38)),
  } as CSSProperties
  return (
    <span className="cm-mono" style={style} aria-hidden="true">
      {initials}
    </span>
  )
}

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

function Star({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  )
}

function QuoteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
      <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
    </svg>
  )
}

/** Evidence badge — the product's only citation shape; hover names the email. */
function Evidence({ ev, label }: { ev: ContactEvidence; label: string }) {
  const tip = `${label} ${ev.id} · ${ev.subject}`
  return (
    <span className="cm-ev" data-tip={tip} role="img" aria-label={tip}>
      <QuoteIcon />
    </span>
  )
}

function Runs({ runs, label }: { runs: ProfileRun[]; label: string }) {
  return (
    <>
      {runs.map((run, i) =>
        typeof run === 'string' ? <span key={i}>{run}</span> : <Evidence key={i} ev={run} label={label} />,
      )}
    </>
  )
}

function SecHead({ title, count }: { title: string; count?: number }) {
  return (
    <div className="cm-sechead">
      <h4>{title}</h4>
      {count != null ? <span className="cm-sechead-n">{count}</span> : null}
      <span className="cm-sechead-rule" aria-hidden="true" />
    </div>
  )
}

export default function ContactMock({ locale = 'zh-CN', data }: ContactMockProps) {
  const d = data ?? contactMock[locale]
  const { chrome: c, person: p } = d
  const sentPct = Math.round((p.sent / p.total) * 100)

  return (
    <div className="cm" data-mock="ContactMock">
      {/* ── contact list (names ≥ 680px · monogram rail 440–679 · hidden < 440) ── */}
      <aside className="cm-list" aria-label={c.listTitle}>
        <div className="cm-list-head">
          <svg className="cm-list-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span className="cm-list-title">{c.listTitle}</span>
          <span className="cm-list-count">{c.listCount}</span>
        </div>
        <div className="cm-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <span>{c.searchPlaceholder}</span>
        </div>
        <div className="cm-rows">
          {d.list.map((row) => (
            <div key={row.name} className={`cm-row${row.selected ? ' sel' : ''}`} title={row.name}>
              <Mono initials={initialsOf(row.name)} tone={row.tone} size={24} />
              <span className="cm-row-text">
                <span className="cm-row-name">{row.name}</span>
                <span className="cm-row-org">{row.org}</span>
              </span>
            </div>
          ))}
        </div>
      </aside>

      {/* ── person page ─────────────────────────────────────────────── */}
      <div className="cm-detail">
        <header className="cm-head">
          <Mono initials={p.initials} tone={p.tone} size={46} />
          <div className="cm-head-main">
            <div className="cm-name-row">
              <span className="cm-name">{p.name}</span>
              <span className="cm-formal">{p.formalName}</span>
            </div>
            <div className="cm-sub">
              <span className="cm-sub-text">{p.subtitle}</span>
              <span className="cm-pip">{p.fnLevel}</span>
            </div>
            <div className="cm-emails" aria-label={c.emailsTitle}>
              {p.emails.map((e) => (
                <span
                  key={e.address}
                  className={`cm-email${e.primary ? ' primary' : ''}${e.former ? ' former' : ''}`}
                >
                  <span className="cm-email-addr">{e.address}</span>
                  {e.primary ? <span className="cm-pip">{c.primary}</span> : null}
                  {e.former ? <span className="cm-pip">{c.former}</span> : null}
                  <span className="cm-email-n">{e.count}</span>
                </span>
              ))}
            </div>
            <div className="cm-stats">
              <span className="cm-stats-ex">{p.exchange}</span>
              <span className="cm-twoway" aria-hidden="true">
                <i style={{ width: `${sentPct}%` }} />
              </span>
              <span className="cm-stats-since">{p.since}</span>
            </div>
          </div>
          <span className="cm-compose">{c.compose}</span>
        </header>

        <div className="cm-body">
          {/* AI profile card */}
          <section className="cm-card">
            <div className="cm-card-head">
              <span className="cm-ai-ic">
                <Star size={12} />
              </span>
              <span className="cm-card-title">{c.profileTitle}</span>
              <span className="cm-basis">{c.profileBasis}</span>
            </div>
            <p className="cm-summary">
              <Runs runs={d.profile.summary} label={c.evidenceLabel} />
            </p>
            <div className="cm-facets">
              <span className="cm-lab">{c.topics}</span>
              <span className="cm-chips">
                {d.profile.topics.map((t) => (
                  <span key={t} className="cm-chip ai">
                    {t}
                  </span>
                ))}
              </span>
              <span className="cm-lab">{c.projects}</span>
              <span className="cm-chips">
                {d.profile.projects.map((t) => (
                  <span key={t} className="cm-chip">
                    {t}
                  </span>
                ))}
              </span>
            </div>
            <div className="cm-evo">
              <div className="cm-lab">{c.evolution}</div>
              <ol>
                {d.profile.evolution.map((item) => (
                  <li key={item.at}>
                    <span className="cm-evo-dot" aria-hidden="true" />
                    <span className="cm-evo-at">{item.at}</span>
                    <span className="cm-evo-text">
                      {item.text}
                      <Evidence ev={item.ev} label={c.evidenceLabel} />
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          {/* reporting line */}
          <section className="cm-org">
            <SecHead title={c.orgTitle} />
            <div className="cm-org-lab">
              <span>{c.manager}</span>
              <span className="cm-aimark">
                <Star size={8} />
                {c.autoSrc}
              </span>
            </div>
            <div className="cm-rel">
              <Mono initials={d.manager.initials} tone={d.manager.tone} size={28} />
              <span className="cm-rel-text">
                <span className="cm-rel-name">{d.manager.name}</span>
                <span className="cm-rel-sub">{d.manager.sub}</span>
              </span>
              <svg className="cm-rel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </div>
            <div className="cm-org-lab">
              <span>{c.peers}</span>
            </div>
            <div className="cm-peers">
              {d.peers.map((peer) => (
                <span key={peer.name} className="cm-peer">
                  <Mono initials={peer.initials} tone={peer.tone} size={18} />
                  {peer.name}
                </span>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
