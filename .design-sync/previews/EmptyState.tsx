// Authored preview — EmptyState (feedback). Icon + title + hint + action.
import { EmptyState, Button } from 'mailagent-frontend'

export const NoEmails = () => (
  <div style={{ width: 460, padding: 24, background: 'rgb(var(--ink-1))' }}>
    <EmptyState
      icon={<span style={{ fontSize: 32 }}>📭</span>}
      title="收件箱已清空"
      hint="所有邮件都已处理完毕，休息一下吧。"
      action={<Button variant="secondary">刷新</Button>}
    />
  </div>
)

export const NoResults = () => (
  <div style={{ width: 460, padding: 24, background: 'rgb(var(--ink-1))' }}>
    <EmptyState icon={<span style={{ fontSize: 32 }}>🔍</span>} title="没有匹配的结果" hint="试试更宽泛的关键词。" />
  </div>
)
