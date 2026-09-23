/**
 * TeamMock — the Team page (团队). Recreates the product's member list + run
 * record (frontend/src/shared/components/team/) at landing-page scale: the
 * main agent, built-in and custom members each with their own avatar → one
 * run of the "Meeting prep" custom agent expanded as a transcript: trigger →
 * thinking → tool calls → output, with steps / tokens / duration at the foot.
 *
 * Avatars are simplified static SVGs (a rounded geometric body + two eyes),
 * one silhouette and tone per member; the product's bot avatar is a richer
 * stateful module, deliberately not reproduced here.
 *
 * Layout follows the mock's own width (container queries), not the viewport:
 *   ≥ 520px  member list on the left, run record on the right
 *   < 520    member list hidden, run record only
 *
 * Presentational only — pure props → JSX, fictional data, no network.
 */
import type { CSSProperties, ReactNode } from 'react'
import './TeamMock.css'
import { teamMock, type AvatarShape, type TeamMember, type TeamTone } from './fixtures/TeamMock'

export interface TeamMockProps {
  locale?: 'zh-CN' | 'en'
}

const BODY: Record<AvatarShape, ReactNode> = {
  squircle: <rect className="tm-av-body" x="3" y="3" width="18" height="18" rx="6.5" />,
  circle: <circle className="tm-av-body" cx="12" cy="12" r="9.2" />,
  hex: <path className="tm-av-body" d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z" />,
  capsule: <rect className="tm-av-body" x="2.2" y="5.5" width="19.6" height="13" rx="6.5" />,
  diamond: (
    <rect className="tm-av-body" x="5.2" y="5.2" width="13.6" height="13.6" rx="3.6" transform="rotate(45 12 12)" />
  ),
  arch: <path className="tm-av-body" d="M4.5 20.5V12a7.5 7.5 0 0 1 15 0v8.5Z" />,
}

const EYE_Y: Record<AvatarShape, number> = {
  squircle: 11.6,
  circle: 11.6,
  hex: 11.8,
  capsule: 12,
  diamond: 12,
  arch: 12.6,
}

function Avatar({ shape, tone, size }: { shape: AvatarShape; tone: TeamTone; size: number }) {
  return (
    <svg
      className="tm-av"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{ '--tone': `var(--c-${tone})` } as CSSProperties}
      aria-hidden="true"
    >
      {BODY[shape]}
      <ellipse className="tm-av-eye" cx="9.3" cy={EYE_Y[shape]} rx="1.2" ry="1.6" />
      <ellipse className="tm-av-eye" cx="14.7" cy={EYE_Y[shape]} rx="1.2" ry="1.6" />
    </svg>
  )
}

function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function MemberRow({ m, tag }: { m: TeamMember; tag?: string }) {
  return (
    <div className={`tm-member${m.selected ? ' sel' : ''}`}>
      <Avatar shape={m.shape} tone={m.tone} size={26} />
      <span className="tm-member-text">
        <span className="tm-member-top">
          <span className="tm-member-name">{m.name}</span>
          {tag ? <span className="tm-tag">{tag}</span> : null}
        </span>
        <span className={`tm-member-sub${m.working ? ' working' : ''}`}>{m.sub}</span>
      </span>
    </div>
  )
}

export default function TeamMock({ locale = 'zh-CN' }: TeamMockProps) {
  const d = teamMock[locale]
  const c = d.chrome
  const r = d.run
  const agent = d.custom.find((m) => m.selected) ?? d.custom[0]

  return (
    <div className="tm" data-mock="TeamMock">
      {/* ── member list (hidden < 520px) ─────────────────────────────── */}
      <aside className="tm-list" aria-label={c.title}>
        <div className="tm-list-head">{c.title}</div>
        <div className="tm-members">
          <MemberRow m={d.main} tag={c.primaryTag} />
          <div className="tm-group">{c.builtin}</div>
          {d.builtin.map((m) => (
            <MemberRow key={m.name} m={m} />
          ))}
          <div className="tm-group">{c.custom}</div>
          {d.custom.map((m) => (
            <MemberRow key={m.name} m={m} />
          ))}
          <div className="tm-new">
            <Glyph>
              <path d="M12 5v14M5 12h14" />
            </Glyph>
            {c.newAgent}
          </div>
        </div>
      </aside>

      {/* ── run record ───────────────────────────────────────────────── */}
      <div className="tm-detail">
        <header className="tm-head">
          <Avatar shape={agent.shape} tone={agent.tone} size={32} />
          <span className="tm-head-text">
            <span className="tm-head-name">{agent.name}</span>
            <span className="tm-head-sub">{r.agentSub}</span>
          </span>
          <span className="tm-tabs">
            <span className="tm-tab">{c.tabs.chat}</span>
            <span className="tm-tab on">{c.tabs.record}</span>
            <span className="tm-tab">{c.tabs.settings}</span>
          </span>
        </header>

        <div className="tm-run">
          <div className="tm-run-head">
            <div className="tm-run-title">{r.title}</div>
            <div className="tm-run-src">
              <span className="tm-badge">{c.triggerBadge}</span>
              <span className="tm-run-when">{r.source}</span>
            </div>
          </div>

          <ol className="tm-steps">
            <li className="tm-step">
              <span className="tm-dot" aria-hidden="true">
                <Glyph>
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" />
                </Glyph>
              </span>
              <div className="tm-step-body">
                <div className="tm-step-lab">{c.triggerLabel}</div>
                <div className="tm-step-text">{r.trigger}</div>
              </div>
            </li>

            <li className="tm-step">
              <span className="tm-dot tm-dot--ai" aria-hidden="true">
                <Glyph>
                  <path d="M12 3 13.9 10.1 21 12l-7.1 1.9L12 21l-1.9-7.1L3 12l7.1-1.9z" />
                </Glyph>
              </span>
              <div className="tm-step-body">
                <div className="tm-step-lab">
                  {c.thinkingLabel}
                  <Glyph className="tm-caret">
                    <path d="m6 9 6 6 6-6" />
                  </Glyph>
                </div>
                <div className="tm-think">{r.thinking}</div>
              </div>
            </li>

            <li className="tm-step">
              <span className="tm-dot" aria-hidden="true">
                <Glyph>
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </Glyph>
              </span>
              <div className="tm-step-body">
                <ul className="tm-tools">
                  {r.tools.map((t) => (
                    <li key={t.label} className="tm-tool">
                      <Glyph className="tm-ok">
                        <path d="M20 6 9 17l-5-5" />
                      </Glyph>
                      <span className="tm-tool-lab">{t.label}</span>
                      <span className="tm-tool-detail">{t.detail}</span>
                      <span className="tm-tool-took">{t.took}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </li>

            <li className="tm-step">
              <span className="tm-dot tm-dot--out" aria-hidden="true">
                <Glyph>
                  <path d="M20 6 9 17l-5-5" />
                </Glyph>
              </span>
              <div className="tm-step-body">
                <div className="tm-step-lab">{c.outputLabel}</div>
                <div className="tm-output">{r.output}</div>
                <span className="tm-file">
                  <Glyph>
                    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                  </Glyph>
                  <span className="tm-file-name">{r.file}</span>
                </span>
              </div>
            </li>
          </ol>

          <footer className="tm-stats">
            <span>
              <i>{c.steps}</i> {r.stats.steps}
            </span>
            <span>
              <i>{c.tokens}</i> {r.stats.tokens}
            </span>
            <span>
              <i>{c.duration}</i> {r.stats.duration}
            </span>
          </footer>
        </div>
      </div>
    </div>
  )
}
