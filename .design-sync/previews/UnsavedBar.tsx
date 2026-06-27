// Authored preview — UnsavedBar (the sticky "unsaved changes" save bar).
// It positions `fixed`, so we give it a `transform`ed ancestor: that makes the
// container the containing block for the fixed bar, keeping it inside the card.
import type { ReactNode } from 'react'
import { UnsavedBar } from 'mailagent-frontend'

function Stage({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: 'relative', transform: 'translateZ(0)', width: 560, height: 96, background: 'rgb(var(--ink-1))', borderRadius: 10, overflow: 'hidden', border: '1px solid rgb(var(--ink-border) / 0.5)' }}>
      {children}
    </div>
  )
}

export const Pending = () => (
  <Stage>
    <UnsavedBar count={3} onSave={() => {}} onDiscard={() => {}} />
  </Stage>
)

export const Saving = () => (
  <Stage>
    <UnsavedBar count={1} busy onSave={() => {}} onDiscard={() => {}} />
  </Stage>
)
