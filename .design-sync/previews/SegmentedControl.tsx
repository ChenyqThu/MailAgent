// Authored preview — SegmentedControl (segmented toggle, default + accent tone).
import { SegmentedControl } from 'mailagent-frontend'

export const ViewModes = () => (
  <div style={{ padding: 24, background: 'rgb(var(--ink-1))', display: 'grid', gap: 18, width: 380 }}>
    <SegmentedControl
      ariaLabel="视图"
      value="list"
      onChange={() => {}}
      options={[
        { value: 'list', label: '列表' },
        { value: 'thread', label: '会话' },
        { value: 'focus', label: '专注' }
      ]}
    />
    <SegmentedControl
      ariaLabel="主题"
      tone="accent"
      value="dark"
      onChange={() => {}}
      options={[
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' },
        { value: 'auto', label: '跟随系统' }
      ]}
    />
  </div>
)
