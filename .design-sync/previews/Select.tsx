// Authored preview — Select (Radix + Tailwind compound). Composed as a small
// settings-style form so the resting (closed) trigger reads as real UI rather
// than a lone button. Sub-parts (SelectTrigger/Value/Content/Item) are
// composed inside their Select root — the only render that is true anyway.
import type { ReactNode } from 'react'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from 'mailagent-frontend'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-2))' }}>{label}</span>
      {children}
    </label>
  )
}

export const SettingsForm = () => (
  <div style={{ display: 'grid', gap: 18, padding: 24, width: 320, background: 'rgb(var(--ink-1))' }}>
    <Field label="默认文件夹">
      <Select defaultValue="inbox">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inbox">收件箱</SelectItem>
          <SelectItem value="sent">已发送</SelectItem>
          <SelectItem value="drafts">草稿箱</SelectItem>
          <SelectItem value="archive">归档</SelectItem>
        </SelectContent>
      </Select>
    </Field>
    <Field label="同步频率">
      <Select defaultValue="5m">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1m">每分钟</SelectItem>
          <SelectItem value="5m">每 5 分钟</SelectItem>
          <SelectItem value="15m">每 15 分钟</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  </div>
)
