/**
 * IslandMock — the Dynamic-Island Live Activity card (LIVE pulse + mail
 * summary + 3 action buttons). Faithful recreation of the reference
 * .pi-stage / .island block (MailAgent.html + global.css .pi-*). Tier-2 mock.
 * Drives off fixtures.island.
 *
 * Presentational only — pure props → JSX, no product imports, no window.electron.
 */
import type { MockIslandItem, Priority } from './fixtures/fixtures'
import { island as defaultIsland } from './fixtures/fixtures'

export interface IslandMockProps {
  /** The live-activity item to render. Defaults to fixtures.island. */
  item?: MockIslandItem
  /** Localized action button labels override (else item.actions). */
  actions?: string[]
  /** Toggle the pulsing LIVE indicator (respects prefers-reduced-motion). */
  live?: boolean
  locale?: 'zh-CN' | 'en'
}

/** Priority → token name for the badge tint (theme-aware). */
const PRI_TOKEN: Record<Priority, string> = {
  crit: '--c-crit',
  urg: '--c-urg',
  impt: '--c-impt',
  norm: '--ink-fg-2',
  low: '--ink-fg-2',
}

export default function IslandMock({
  item = defaultIsland,
  actions,
  live = true,
}: IslandMockProps) {
  // `locale` is part of the prop contract but unused here: the island renders
  // fixture data verbatim and its only chrome string ("LIVE") is universal.
  const btnLabels = actions ?? item.actions
  const priToken = PRI_TOKEN[item.priority]
  // The first action is the primary (accent) button, matching the reference.
  return (
    <div className="pi-stage" data-mock="IslandMock">
      <div className="island">
        <div className="island-head">
          <span className="lab">MailAgent · Ping Island</span>
          <span className="live">
            {live ? <span className="d" /> : null}
            LIVE
          </span>
        </div>
        <div className="pi-mail">
          <div className="pi-av" style={{ background: item.avatarColor }}>
            {item.avatarInitials}
          </div>
          <div className="pi-body">
            <div className="pi-eb">
              <span
                className="pri"
                style={{
                  background: `rgb(var(${priToken}) / 0.16)`,
                  color: `rgb(var(${priToken}))`,
                }}
              >
                {item.priorityLabel}
              </span>
              <span>{item.sender}</span>
            </div>
            <div className="pi-tt">{item.title}</div>
            <div className="pi-ss">{item.subtitle}</div>
          </div>
        </div>
        <div className="pi-actions">
          {btnLabels.map((label, i) => (
            <button key={label + i} className={`pi-btn${i === 0 ? ' acc' : ''}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
