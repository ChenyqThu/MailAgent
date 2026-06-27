// Authored preview — PageHeader (eyebrow + title + description).
import { PageHeader } from 'mailagent-frontend'

export const Header = () => (
  <div style={{ width: 640, padding: 28, background: 'rgb(var(--ink-1))' }}>
    <PageHeader eyebrow="设置" title="通用" description="语言、主题、启动行为与默认账户。" />
  </div>
)
