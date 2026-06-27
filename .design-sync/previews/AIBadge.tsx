// Authored preview — AIBadge priority chip (DESIGN.md §5.2). Each export is
// one card cell. Real component imported from the package global.
import type { ReactNode } from 'react'
import { AIBadge } from 'mailagent-frontend'

function Row({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: 20, background: 'rgb(var(--ink-1))' }}>
      {children}
    </div>
  )
}

export const Priorities = () => (
  <Row>
    <AIBadge priority="critical">Critical</AIBadge>
    <AIBadge priority="urgent">Urgent</AIBadge>
    <AIBadge priority="important">Important</AIBadge>
    <AIBadge priority="normal">Normal</AIBadge>
    <AIBadge priority="low">Low</AIBadge>
  </Row>
)

export const WithDot = () => (
  <Row>
    <AIBadge priority="critical" withDot>
      Critical
    </AIBadge>
    <AIBadge priority="urgent" withDot>
      Urgent
    </AIBadge>
    <AIBadge priority="important" withDot>
      Important
    </AIBadge>
  </Row>
)
