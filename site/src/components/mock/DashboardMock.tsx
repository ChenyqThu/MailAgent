/**
 * DashboardMock — the LLM observability dashboard (4 stat cards + status donut
 * + cache-hit bar). Faithful recreation of the reference .dash block
 * (MailAgent.html + global.css .dash / .dcard / .donut / .dbar). Tier-2/3 mock.
 * Drives off fixtures.dashboard.
 *
 * §7.3: the status ring is rendered as an SVG arc (stroke-dasharray), NOT the
 * reference's conic-gradient + --p hack — far more reliable across browsers.
 *
 * Presentational only — pure props → JSX, no product imports, no window.electron.
 */
import type { MockDashboard } from './fixtures/fixtures'
import { dashboard as defaultDashboard } from './fixtures/fixtures'

export interface DashboardMockProps {
  /** Dashboard data. Defaults to fixtures.dashboard. */
  data?: MockDashboard
  /** Selected time range tab. */
  range?: '7d' | '30d' | '90d'
  locale?: 'zh-CN' | 'en'
}

const RANGES = ['7d', '30d', '90d'] as const

interface Chrome {
  title: string
  status: string
  cacheHit: string
  cacheWrite: string
  cacheRead: string
  total: string
}

const CHROME: Record<'zh-CN' | 'en', Chrome> = {
  'zh-CN': { title: 'LLM 看板', status: '状态分布', cacheHit: '缓存命中率', cacheWrite: '缓存写入', cacheRead: '命中', total: 'total' },
  en: { title: 'LLM Dashboard', status: 'Status', cacheHit: 'Cache hit rate', cacheWrite: 'Cache write', cacheRead: 'Cache read', total: 'total' },
}

/** Format the donut total with thousands separators, matching the reference. */
function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** SVG status ring — replaces the reference conic-gradient hack (§7.3). */
function StatusRing({ total, success }: { total: number; success: number }) {
  const r = 41.5
  const c = 2 * Math.PI * r
  const frac = total > 0 ? Math.min(1, success / total) : 0
  const dash = c * frac
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* track (pending remainder) */}
      <circle cx="48" cy="48" r={r} fill="none" stroke="rgb(var(--ink-4))" strokeWidth="13" />
      {/* success arc — rotate -90° so it starts at 12 o'clock (no extra offset) */}
      <circle
        cx="48"
        cy="48"
        r={r}
        fill="none"
        stroke="rgb(var(--c-ok))"
        strokeWidth="13"
        strokeDasharray={`${dash} ${c - dash}`}
        strokeLinecap="butt"
        transform="rotate(-90 48 48)"
      />
    </svg>
  )
}

export default function DashboardMock({ data = defaultDashboard, range, locale = 'zh-CN' }: DashboardMockProps) {
  const t = CHROME[locale]
  const activeRange = range ?? data.range
  const hitPct = Math.max(0, Math.min(100, data.cacheHitRate))

  return (
    <div className="dash" data-mock="DashboardMock">
      <div className="dash-head">
        <span className="star">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
          </svg>
        </span>
        <h4>{t.title}</h4>
        <div className="seg">
          {RANGES.map((rg) => (
            <button key={rg} className={rg === activeRange ? 'on' : ''}>
              {rg}
            </button>
          ))}
        </div>
      </div>

      <div className="dash-cards">
        {data.cards.map((card, i) => (
          <div key={card.key + i} className={`dcard${card.accent ? ' acc' : ''}`}>
            <div className="dk">{card.key}</div>
            <div className="dv">{card.value}</div>
            <div className="ds">{card.sub}</div>
          </div>
        ))}
      </div>

      <div className="dash-low">
        <div className="dpanel">
          <div className="dk">{t.status}</div>
          <div className="donut-wrap">
            <div style={{ position: 'relative', width: 96, height: 96, flexShrink: 0 }}>
              <StatusRing total={data.status.total} success={data.status.success} />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  textAlign: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
                    {fmt(data.status.total)}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      textTransform: 'uppercase',
                      color: 'rgb(var(--ink-fg-2))',
                    }}
                  >
                    {t.total}
                  </div>
                </div>
              </div>
            </div>
            <div className="dleg">
              <div className="lr">
                <span className="sw" style={{ background: 'rgb(var(--c-ok))' }} />
                success
                <span className="v">{fmt(data.status.success)}</span>
              </div>
              <div className="lr">
                <span className="sw" style={{ background: 'rgb(var(--c-info))' }} />
                pending
                <span className="v">{fmt(data.status.pending)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dpanel">
          <div className="dk">{t.cacheHit}</div>
          <div className="dbar-lab">
            <span>{hitPct.toFixed(1)}%</span>
            <span>target ≥ {data.cacheTarget}%</span>
          </div>
          <div className="dbar">
            <i style={{ width: `${hitPct}%` }} />
          </div>
          <div className="dkv">
            <div>
              <div className="k">{t.cacheWrite}</div>
              <div className="v">{data.cacheWrite}</div>
            </div>
            <div>
              <div className="k">{t.cacheRead}</div>
              <div className="v">{data.cacheRead}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
