// Authored preview — DotMatrix (animated status dot grid). Static capture
// shows a representative frame per state.
import { DotMatrix } from 'mailagent-frontend'

export const States = () => (
  <div style={{ padding: 28, background: 'rgb(var(--ink-1))', display: 'flex', gap: 36, alignItems: 'center' }}>
    <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
      <DotMatrix state="idle" />
      <span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))', fontFamily: 'ui-monospace, monospace' }}>idle</span>
    </div>
    <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
      <DotMatrix state="loading" />
      <span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))', fontFamily: 'ui-monospace, monospace' }}>loading</span>
    </div>
    <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
      <DotMatrix state="thinking" />
      <span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))', fontFamily: 'ui-monospace, monospace' }}>thinking</span>
    </div>
  </div>
)
