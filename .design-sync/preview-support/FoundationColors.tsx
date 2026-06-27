// design-sync foundation card — color tokens.
// Pure presentational (no imports beyond JSX runtime). Renders its OWN dark
// panel so swatches read on the card's white body. Colours come from the
// shipped `:root` custom properties via `rgb(var(--token))` — guaranteed
// present regardless of which Tailwind utilities the app compiled.
// Source of truth: frontend renderer index.css `:root` (rgb space-separated).

type Sw = { name: string; v: string }

function Swatch({ name, v }: Sw) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          height: 54,
          borderRadius: 8,
          background: `rgb(var(--${name}))`,
          border: '1px solid rgb(var(--ink-border) / 0.6)'
        }}
      />
      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 11, color: 'rgb(var(--ink-fg-2))' }}>
        --{name}
      </div>
      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 11, color: 'rgb(var(--ink-fg-3))' }}>
        {v}
      </div>
    </div>
  )
}

function Group({ title, items }: { title: string; items: Sw[] }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div
        style={{
          fontSize: 12,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'rgb(var(--ink-fg-3))',
          marginBottom: 12
        }}
      >
        {title}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(116px, 1fr))', gap: 16 }}>
        {items.map((s) => (
          <Swatch key={s.name} {...s} />
        ))}
      </div>
    </div>
  )
}

export function FoundationColors() {
  return (
    <div style={{ background: 'rgb(var(--ink-1))', padding: 28, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'rgb(var(--ink-fg))', marginBottom: 4 }}>Color tokens</div>
      <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginBottom: 24 }}>
        MailAgent design system · dark-theme defaults · referenced as <code>rgb(var(--token))</code>
      </div>

      <Group
        title="Surfaces (ink)"
        items={[
          { name: 'ink-0', v: '14 16 19' },
          { name: 'ink-1', v: '21 24 29' },
          { name: 'ink-2', v: '26 30 36' },
          { name: 'ink-3', v: '31 36 43' },
          { name: 'ink-4', v: '38 44 53' },
          { name: 'ink-5', v: '46 52 62' }
        ]}
      />
      <Group
        title="Text (ink-fg)"
        items={[
          { name: 'ink-fg', v: '232 234 238' },
          { name: 'ink-fg-1', v: '192 198 208' },
          { name: 'ink-fg-2', v: '162 168 180' },
          { name: 'ink-fg-3', v: '152 158 170' }
        ]}
      />
      <Group
        title="Borders"
        items={[
          { name: 'ink-border', v: '76 84 96' },
          { name: 'ink-border-soft', v: '58 65 76' }
        ]}
      />
      <Group
        title="Accent (coral)"
        items={[
          { name: 'c-accent', v: '248 138 125' },
          { name: 'c-accent-hi', v: '230 123 110' },
          { name: 'c-accent-dim', v: '142 63 54' },
          { name: 'c-accent-fg', v: '15 16 21' }
        ]}
      />
    </div>
  )
}
