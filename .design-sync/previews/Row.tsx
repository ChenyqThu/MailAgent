// Authored preview — Row (settings line: label + helper + control + trailing).
import { Row, Input, Switch } from 'mailagent-frontend'

export const Rows = () => (
  <div style={{ width: 500, padding: 20, background: 'rgb(var(--ink-1))', display: 'grid', gap: 2 }}>
    <Row label="桌面通知" helper="新邮件到达时弹出系统通知">
      <Switch defaultChecked />
    </Row>
    <Row label="账户邮箱" helper="用于同步的 Exchange 地址">
      <Input defaultValue="lucien@omadanetworks.com" />
    </Row>
    <Row label="自动归档" helper="已处理邮件移出收件箱" trailing={<span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))' }}>30 天</span>}>
      <Switch />
    </Row>
  </div>
)
