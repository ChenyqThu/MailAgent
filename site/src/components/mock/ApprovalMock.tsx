/**
 * ApprovalMock — an in-chat approval card plus an excerpt of the per-tool
 * approval tiers. Recreates the product's PendingApprovalPanel
 * (frontend/src/shared/assistant/PendingApprovalPanel.tsx) and the Settings →
 * AI tool-tier list at landing-page scale: tool + tier, the exact action,
 * the draft it would write, the "remember" checkbox, approve / edit / deny;
 * below it, four tools across the three tiers, one of them fixed.
 *
 * No window chrome: it sits bare in the proof column. Layout follows the
 * mock's own width (container queries):
 *   ≥ 420px  tier rows show the full three-way switch and the tool id
 *   < 420    tier rows collapse to the active tier only
 *
 * Presentational only — pure props → JSX, fictional data, no network.
 */
import type { ReactNode } from 'react'
import './ApprovalMock.css'
import { approvalMock, type ApprovalMockData, type ApprovalTier } from './fixtures/ApprovalMock'

export interface ApprovalMockProps {
  locale?: 'zh-CN' | 'en'
  /** Override the canned data (defaults to fixtures/ApprovalMock for the locale). */
  data?: ApprovalMockData
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

const ReplyIcon = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M9 17 4 12l5-5" />
    <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
  </Svg>
)
const BellIcon = ({ size = 12 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Svg>
)
const LockIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
)
const PencilIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
  </Svg>
)
const ShieldIcon = ({ size = 13 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z" />
  </Svg>
)

const TIER_ORDER: ApprovalTier[] = ['auto', 'ask', 'deny']

export default function ApprovalMock({ locale = 'zh-CN', data }: ApprovalMockProps) {
  const d = data ?? approvalMock[locale]
  const c = d.card
  const t = d.tiers

  return (
    <div className="apm" data-mock="ApprovalMock">
      {/* ── approval card ─────────────────────────────────────────────── */}
      <div className="apm-card">
        <div className="apm-status">
          <BellIcon />
          <span className="apm-status-title">{c.title}</span>
          <span className="apm-status-ago">{c.ago}</span>
        </div>

        <div className="apm-tool">
          <span className="apm-tool-ic">
            <ReplyIcon />
          </span>
          <span className="apm-tool-text">
            <span className="apm-tool-name">{c.tool}</span>
            <span className="apm-tool-id">{c.toolId}</span>
          </span>
          <span className="apm-pip">{c.tierLabel}</span>
        </div>

        <p className="apm-lead">{c.lead}</p>

        <div className="apm-facts">
          {c.facts.map((f) => (
            <div key={f.label} className="apm-fact">
              <span className="apm-fact-k">{f.label}</span>
              <span className="apm-fact-v">{f.value}</span>
            </div>
          ))}
          <div className="apm-fact body">
            <span className="apm-fact-k">{c.bodyLabel}</span>
            <span className="apm-fact-v">
              {c.body.map((line) => (
                <span key={line} className="apm-body-line">
                  {line}
                </span>
              ))}
            </span>
          </div>
        </div>
        <p className="apm-hint">{c.hint}</p>

        <div className="apm-remember">
          <span className="apm-check" aria-hidden="true" />
          <span>{c.remember}</span>
        </div>

        <div className="apm-actions">
          <span className="apm-btn primary">{c.approve}</span>
          <span className="apm-btn">
            <PencilIcon />
            {c.editParams}
          </span>
          <span className="apm-btn ghost" title={c.rejectHint}>
            {c.reject}
          </span>
        </div>
      </div>

      {/* ── per-tool approval tiers (excerpt) ─────────────────────────── */}
      <div className="apm-tiers">
        <div className="apm-tiers-head">
          <ShieldIcon />
          <span>{t.title}</span>
        </div>
        <ul className="apm-tier-rows">
          {t.rows.map((row) => (
            <li key={row.id} className="apm-tier-row">
              <span className="apm-tier-tool">
                <span className="apm-tier-name">{row.tool}</span>
                <span className="apm-tier-id">{row.id}</span>
              </span>
              {row.tier ? (
                <span className="apm-seg" role="img" aria-label={`${row.tool}: ${t.labels[row.tier]}`}>
                  {TIER_ORDER.map((tier) => (
                    <span key={tier} className={`apm-seg-opt ${tier}${tier === row.tier ? ' on' : ''}`}>
                      {t.labels[tier]}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="apm-fixed" title={t.fixedTip}>
                  <LockIcon />
                  {t.fixed}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
