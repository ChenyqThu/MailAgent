// Authored preview — Section (settings group: title + helper + rows).
import { Section, Row, Switch } from 'mailagent-frontend'

export const SettingsGroup = () => (
  <div style={{ width: 540, padding: 20, background: 'rgb(var(--ink-1))' }}>
    <Section
      title="通知"
      helper="控制 MailAgent 如何提醒你"
      meta={<span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))' }}>2 项已开启</span>}
    >
      <Row label="桌面通知">
        <Switch defaultChecked />
      </Row>
      <Row label="飞书推送">
        <Switch defaultChecked />
      </Row>
      <Row label="仅重要邮件">
        <Switch />
      </Row>
    </Section>
  </div>
)
