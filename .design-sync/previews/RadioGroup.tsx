// Authored preview — RadioGroup (Radix radio group, composed with labels).
import { RadioGroup, RadioGroupItem } from 'mailagent-frontend'

const OPTIONS: [string, string][] = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['auto', '跟随系统']
]

export const Theme = () => (
  <div style={{ padding: 24, background: 'rgb(var(--ink-1))', width: 320 }}>
    <RadioGroup defaultValue="auto" style={{ display: 'grid', gap: 14 }}>
      {OPTIONS.map(([v, label]) => (
        <label key={v} htmlFor={`theme-${v}`} style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'rgb(var(--ink-fg-1))', fontSize: 14 }}>
          <RadioGroupItem id={`theme-${v}`} value={v} />
          {label}
        </label>
      ))}
    </RadioGroup>
  </div>
)
