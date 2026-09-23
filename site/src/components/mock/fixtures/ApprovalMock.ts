/**
 * Synthetic data for ApprovalMock (an in-chat approval card + the per-tool
 * approval tiers). Every person, company and address here is fictional;
 * addresses use the reserved `.example` domain. Interface strings that exist
 * in the product are copied verbatim from
 * frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json
 * (`agents.custom.runs.*`, `chat.aiSdk.approvalBodyManual`, `chat.approvalShell.*`,
 * `chat.draftComposeCard.*`, `chat.toolTitle.*`, `settings.ai.toolPrefs.*`);
 * the ICU placeholders are pre-filled.
 */

export type ApprovalTier = 'auto' | 'ask' | 'deny'

export interface ApprovalTierRow {
  tool: string
  id: string
  /** Current tier; omitted when the tool's approval shape is fixed. */
  tier?: ApprovalTier
}

export interface ApprovalMockData {
  card: {
    title: string
    ago: string
    tool: string
    toolId: string
    tierLabel: string
    lead: string
    facts: { label: string; value: string }[]
    bodyLabel: string
    body: string[]
    hint: string
    remember: string
    approve: string
    editParams: string
    reject: string
    rejectHint: string
  }
  tiers: {
    title: string
    labels: Record<ApprovalTier, string>
    fixed: string
    fixedTip: string
    rows: ApprovalTierRow[]
  }
}

export const approvalMock: Record<'zh-CN' | 'en', ApprovalMockData> = {
  'zh-CN': {
    card: {
      title: '待审批',
      ago: '刚刚',
      tool: '起草回复',
      toolId: 'email_draft_reply',
      tierLabel: '先确认',
      lead: 'AI 请求执行 起草回复，需要你批准。',
      facts: [
        { label: '收件人', value: 'maya.lin@northwind.example' },
        { label: '主题', value: 'Re: 欧洲区回滚窗口确认' },
      ],
      bodyLabel: '草稿正文',
      body: ['Maya，你好：', '回滚窗口按 10月3日 02:00–04:00 准备，法务复核周四前给你结论。'],
      hint: '以下内容将存入草稿箱，不会发送（可编辑后再确认）',
      remember: '记住：以后不再询问这类操作',
      approve: '批准',
      editParams: '编辑参数',
      reject: '拒绝',
      rejectHint: '说明为什么不批准，以及希望改成什么做法',
    },
    tiers: {
      title: '工具审批档',
      labels: { auto: '直接执行', ask: '先确认', deny: '禁用' },
      fixed: '恒需确认',
      fixedTip: '该工具的审批形状固定：发送走收件人白名单、本地命令走自动化策略白名单、Skill 安装与 Agent 改动恒弹卡。',
      rows: [
        { tool: '起草新邮件', id: 'email_draft_compose', tier: 'auto' },
        { tool: '起草回复', id: 'email_draft_reply', tier: 'ask' },
        { tool: '准备发送邮件', id: 'email_prepare_send' },
        { tool: '删除日程', id: 'calendar_event_delete', tier: 'ask' },
      ],
    },
  },
  en: {
    card: {
      title: 'Approval pending',
      ago: 'just now',
      tool: 'Draft reply',
      toolId: 'email_draft_reply',
      tierLabel: 'Ask first',
      lead: 'The assistant wants to run Draft reply — your approval is required.',
      facts: [
        { label: 'To', value: 'maya.lin@northwind.example' },
        { label: 'Subject', value: 'Re: EU rollback window' },
      ],
      bodyLabel: 'Draft body',
      body: ['Hi Maya,', "We'll hold the rollback window on Oct 3, 02:00–04:00. Legal will confirm by Thursday."],
      hint: 'This will be saved to Drafts — nothing is sent (edit before confirming)',
      remember: 'Remember: stop asking about this kind of action',
      approve: 'Approve',
      editParams: 'Edit parameters',
      reject: 'Deny',
      rejectHint: 'Say why, and what you want done instead',
    },
    tiers: {
      title: 'Per-tool approval tiers',
      labels: { auto: 'Run directly', ask: 'Ask first', deny: 'Disabled' },
      fixed: 'Always asks',
      fixedTip:
        "This tool's approval shape is fixed: sends use the recipient whitelist, local commands use the automation-policy whitelist, skill installs and agent changes always show a card.",
      rows: [
        { tool: 'Draft new email', id: 'email_draft_compose', tier: 'auto' },
        { tool: 'Draft reply', id: 'email_draft_reply', tier: 'ask' },
        { tool: 'Prepare to send', id: 'email_prepare_send' },
        { tool: 'Delete event', id: 'calendar_event_delete', tier: 'ask' },
      ],
    },
  },
}
