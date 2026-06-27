// design-sync foundation card — semantic colour chips (priority + status).
// Mirrors the AIBadge / status-chip pattern `bg-<tok>/15 text-<tok>` using the
// raw `--c-<tok>` custom properties so it stays correct without relying on a
// specific utility being compiled.

type Chip = { tok: string; label: string }

const PRIORITY: Chip[] = [
  { tok: 'crit', label: 'CRITICAL' },
  { tok: 'urg', label: 'URGENT' },
  { tok: 'impt', label: 'IMPORTANT' },
  { tok: 'norm', label: 'NORMAL' }
]

const STATUS: Chip[] = [
  { tok: 'ok', label: 'OK' },
  { tok: 'warn', label: 'WARN' },
  { tok: 'fail', label: 'FAIL' },
  { tok: 'ai', label: 'AI' }
]

function Pill({ tok, label }: Chip) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        fontSize: 11,
        letterSpacing: '0.05em',
        padding: '3px 8px',
        borderRadius: 6,
        color: `rgb(var(--c-${tok}))`,
        background: `rgb(var(--c-${tok}) / 0.15)`,
        border: `1px solid rgb(var(--c-${tok}) / 0.30)`
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: `rgb(var(--c-${tok}))` }} />
      {label}
    </span>
  )
}

function Band({ title, chips }: { title: string; chips: Chip[] }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgb(var(--ink-fg-3))', marginBottom: 12 }}>
        {title}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {chips.map((c) => (
          <Pill key={c.tok} {...c} />
        ))}
      </div>
    </div>
  )
}

export function FoundationSemantics() {
  return (
    <div style={{ background: 'rgb(var(--ink-1))', padding: 28, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'rgb(var(--ink-fg))', marginBottom: 4 }}>Semantic chips</div>
      <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginBottom: 24 }}>
        Priority &amp; status tokens · pattern <code>bg-&lt;tok&gt;/15 text-&lt;tok&gt;</code>
      </div>
      <Band title="AI priority" chips={PRIORITY} />
      <Band title="Status / sync" chips={STATUS} />
    </div>
  )
}
