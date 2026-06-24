// chat-panel P4 Phase 04a — A2UI tool-card 截图 harness 入口（独立 vite，非默认 bundle）。
//
// 复用 renderer 真实 index.css（同一套 ink-* / c-accent token + 主题三态 + accent override），
// 据 URL ?theme= / ?accent= 在 documentElement 上设 data-theme / data-accent —— 与生产
// appearance.ts 写的是同两个属性，故 token 解析完全一致。渲染三张富卡片的关键状态（pending /
// done），证明 MAILAGENT_A2UI_TOOL_CARDS=1 下卡片正常渲染。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { DraftReplyCard } from '@shared/assistant/tools/mail/DraftReplyCard'
import { SendApprovalCard } from '@shared/assistant/tools/mail/SendApprovalCard'
import { NotionSyncCard } from '@shared/assistant/tools/notion/NotionSyncCard'
import { ApprovalActionCard } from '@shared/assistant/tools/generic/ApprovalActionCard'
import { ToolTraceCard } from '@shared/assistant/tools/generic/ToolTraceCard'

// renderer 真实 token + tailwind base/utilities。
import '../../src/electron/renderer/index.css'

const params = new URLSearchParams(window.location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
const accent = params.get('accent')
document.documentElement.setAttribute('data-theme', theme)
if (accent && accent !== 'coral') document.documentElement.setAttribute('data-accent', accent)
else document.documentElement.removeAttribute('data-accent')

document.body.style.margin = '0'
document.body.style.minHeight = '100vh'
document.body.style.background = 'rgb(var(--ink-0))'
document.body.style.padding = '24px'
document.body.style.fontFamily =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif'

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'x',
    toolCallId: 'tc',
    args: {},
    argsText: '{}',
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: 'apr-1' },
    addResult: () => {},
    resume: () => {},
    respondToApproval: () => {},
    ...over
  } as unknown as ToolCallMessagePartProps
}

function Section({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="mb-1.5 text-meta font-mono uppercase tracking-wider text-ink-fg-3">
        {label}
      </div>
      <div className="rounded-2xl border border-[var(--hairline)] bg-ink-3 px-3.5 py-2 text-ink-fg">
        {children}
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  return (
    <div style={{ maxWidth: 420, margin: '0 auto' }}>
      <div className="mb-3 text-aux font-medium text-ink-fg">
        A2UI 富工具卡片 · MAILAGENT_A2UI_TOOL_CARDS=1
      </div>

      <Section label="DraftReplyCard · 待确认（可编辑正文）">
        <DraftReplyCard
          {...mockProps({
            toolName: 'email_draft_reply',
            args: {
              internal_id: 51240,
              body_markdown: '感谢报价。能否补充单价明细与最快交期？确认后我们再走下单流程。'
            }
          })}
        />
      </Section>

      <Section label="DraftReplyCard · 已创建（含用户修改）">
        <DraftReplyCard
          {...mockProps({
            toolName: 'email_draft_reply',
            status: { type: 'complete' },
            approval: { id: 'a', approved: true },
            args: { internal_id: 51240, body_markdown: 'original' },
            result: {
              internal_id: 51240,
              draft_id: 'reply_all_51240',
              mailbox: 'Drafts',
              user_edited: true,
              final_body_markdown: '感谢报价，已请对方补充单价明细与最快交期。'
            }
          })}
        />
      </Section>

      <Section label="NotionSyncCard · 待确认 / 已重建">
        <NotionSyncCard
          {...mockProps({ toolName: 'email_resync', args: { internal_id: 51240 } })}
        />
        <NotionSyncCard
          {...mockProps({
            toolName: 'email_resync',
            status: { type: 'complete' },
            approval: { id: 'a', approved: true },
            args: { internal_id: 51240 },
            result: {
              internal_id: 51240,
              old_page_id: 'oldpage1234',
              new_page_id: 'newpage5678',
              action: 'recreated'
            }
          })}
        />
      </Section>

      <Section label="ApprovalActionCard · flag / archive（通用审批卡）">
        <ApprovalActionCard
          {...mockProps({
            toolName: 'email_flag',
            args: { internal_id: 51240, is_flagged: true, is_read: true }
          })}
        />
        <ApprovalActionCard
          {...mockProps({
            toolName: 'email_archive',
            status: { type: 'complete' },
            approval: { id: 'a', approved: true },
            args: { internal_id: 51240 },
            result: { internal_id: 51240, archived: true }
          })}
        />
      </Section>

      <Section label="SendApprovalCard · 待确认（blocking · 外部/敏感词 warning · 倒计时）">
        <SendApprovalCard
          {...mockProps({
            toolName: 'email_prepare_send',
            args: {
              to: ['procurement@example-corp.test', 'partner@gmail.com'],
              cc: [],
              subject: '交换机报价确认结论',
              body_markdown: '单价 1280、交期 4 周。另：登录密码见附件。',
              internal_id: 51240
            }
          })}
        />
      </Section>

      <Section label="SendApprovalCard · 已发送（落 Sent）">
        <SendApprovalCard
          {...mockProps({
            toolName: 'email_prepare_send',
            status: { type: 'complete' },
            approval: { id: 'a', approved: true },
            args: {
              to: ['procurement@example-corp.test'],
              subject: '交换机报价确认结论',
              body_markdown: '单价 1280、交期 4 周。'
            },
            result: {
              internal_id: 51240,
              sent: true,
              message_id: '<sent-51240@corp.test>',
              archived_to_sent: true,
              to: ['procurement@example-corp.test'],
              subject: '交换机报价确认结论'
            }
          })}
        />
      </Section>

      <Section label="registry miss · 未注册工具走 generic ToolTraceCard（不阻断）">
        <ToolTraceCard
          {...mockProps({
            toolName: 'email_search',
            status: { type: 'complete' },
            args: { subject_contains: 'redis' },
            argsText: '{"subject_contains":"redis"}',
            result: { count: 3, items: [] }
          })}
        />
      </Section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
