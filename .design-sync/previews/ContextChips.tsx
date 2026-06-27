// Authored preview — ContextChips (agent context summary: body / AI fields /
// thread / Notion project counts).
import { ContextChips } from 'mailagent-frontend'

export const Populated = () => (
  <div style={{ padding: 20, background: 'rgb(var(--ink-1))', width: 500 }}>
    <ContextChips hasEmailBody aiFieldsCount={5} threadCount={3} notionProjectCount={2} />
  </div>
)

export const Minimal = () => (
  <div style={{ padding: 20, background: 'rgb(var(--ink-1))', width: 500 }}>
    <ContextChips hasEmailBody={false} aiFieldsCount={0} threadCount={1} />
  </div>
)
