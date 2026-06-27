// design-sync foundation card — type scale + font families.
// The named sizes mirror the shipped Tailwind scale (text-micro…text-subj).
// Inline px is used so the showcase is robust even if a given utility class
// wasn't compiled into the bundle CSS.

type Row = { cls: string; px: number; use: string }

const SCALE: Row[] = [
  { cls: 'text-subj', px: 22, use: 'Subject / page title' },
  { cls: 'text-lead', px: 15, use: 'Lead / emphasized body' },
  { cls: 'text-body · text-aux', px: 14, use: 'Body copy' },
  { cls: 'text-meta', px: 12, use: 'Meta / secondary' },
  { cls: 'text-micro', px: 11, use: 'Micro / chips / labels' }
]

const FAMILIES: { cls: string; stack: string; sample: string }[] = [
  { cls: 'font-sans', stack: 'system-ui, -apple-system, sans-serif', sample: 'Inbox 收件箱 Reply AaBbCc' },
  { cls: 'font-display', stack: 'system-ui, sans-serif', sample: 'MailAgent · 邮件助手' },
  { cls: 'font-mono', stack: 'ui-monospace, SFMono-Regular, monospace', sample: 'msg_id 53421 · 09:14' }
]

export function FoundationType() {
  return (
    <div style={{ background: 'rgb(var(--ink-1))', padding: 28, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'rgb(var(--ink-fg))', marginBottom: 4 }}>Typography</div>
      <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginBottom: 24 }}>
        Type scale &amp; font families · merge classes with the exported <code>cn()</code> helper
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginBottom: 30 }}>
        {SCALE.map((r) => (
          <div key={r.cls} style={{ display: 'flex', alignItems: 'baseline', gap: 20, borderBottom: '1px solid rgb(var(--ink-border) / 0.4)', paddingBottom: 14 }}>
            <div style={{ width: 150, flexShrink: 0 }}>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'rgb(var(--ink-fg-2))' }}>{r.cls}</div>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'rgb(var(--ink-fg-3))' }}>{r.px}px</div>
            </div>
            <div style={{ fontSize: r.px, color: 'rgb(var(--ink-fg))', lineHeight: 1.3 }}>
              邮件早会纪要 — The quick brown fox
            </div>
            <div style={{ marginLeft: 'auto', fontSize: 11, color: 'rgb(var(--ink-fg-3))', flexShrink: 0 }}>{r.use}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgb(var(--ink-fg-3))', marginBottom: 12 }}>
        Font families
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {FAMILIES.map((f) => (
          <div key={f.cls} style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
            <div style={{ width: 150, flexShrink: 0, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'rgb(var(--ink-fg-2))' }}>{f.cls}</div>
            <div style={{ fontFamily: f.stack, fontSize: 16, color: 'rgb(var(--ink-fg-1))' }}>{f.sample}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
