/**
 * Canned, SYNTHETIC data for the live-mock components (§7). No real API, no
 * real mail — a public site must carry zero real data. Values mirror the
 * reference mockup examples (Alex Rivera 多区域部署 / Sentry 502 / W22 周报 /
 * LLM 看板 5,904 …) so Lane A and Lane D render consistent demos.
 *
 * Types are exported so mock components + Lane A can share one contract.
 */

export type Priority = 'crit' | 'urg' | 'impt' | 'norm' | 'low'

export interface MockEmail {
  id: string
  sender: string
  domain: string
  time: string
  subject: string
  snippet: string
  priority: Priority
  /** Display label for the priority chip (already localized-ish / brand term). */
  priorityLabel: string
  /** Suggested-action chip text (e.g. 需要决策 / Reply Needed). */
  action?: string
  read: boolean
  unread: boolean
  /** EN pill (foreign-language marker) shown next to sender. */
  langPip?: 'EN' | 'JP'
  /** Avatar tint slot (1–6) or 'ext' for external/grey. */
  avatar?: 1 | 2 | 3 | 4 | 5 | 6 | 'ext'
}

export const emails: MockEmail[] = [
  {
    id: 'e1',
    sender: 'Alex Rivera',
    domain: 'northwind.io',
    time: '14:23',
    subject: 'Re: 多区域部署 — 关于 rate limit',
    snippet: '看大家讨论得挺全面了，我补充几点一线观察供参考…',
    priority: 'impt',
    priorityLabel: 'Important',
    action: '需要决策',
    read: false,
    unread: true,
    avatar: 5,
  },
  {
    id: 'e2',
    sender: 'Sentry',
    domain: 'sentry.io',
    time: '14:08',
    subject: '[Alert] webhook 8100: HTTP 502 from upstream',
    snippet: 'Triggered: nginx → webhook (process down). You are oncall.',
    priority: 'crit',
    priorityLabel: 'Critical',
    action: 'Reply Needed',
    read: false,
    unread: true,
    langPip: 'EN',
    avatar: 'ext',
  },
  {
    id: 'e3',
    sender: 'Maya Park',
    domain: 'acme-labs.dev',
    time: '11:40',
    subject: 'Re: 周报 — W22 项目进度对齐',
    snippet: '这周迁移基本收口了，6,184 封邮件全部迁完…',
    priority: 'norm',
    priorityLabel: 'Normal',
    action: '仅供参考',
    read: true,
    unread: false,
    avatar: 4,
  },
  {
    id: 'e4',
    sender: 'Linear',
    domain: 'linear.app',
    time: '昨天',
    subject: 'ENG-1421 assigned to you · "V1 前端脚手架"',
    snippet: 'Sam Okafor moved this issue into "In Progress"…',
    priority: 'norm',
    priorityLabel: 'Normal',
    read: true,
    unread: false,
    langPip: 'EN',
    avatar: 'ext',
  },
  {
    id: 'e5',
    sender: 'Stripe',
    domain: 'stripe.com',
    time: '昨天',
    subject: 'Your invoice for May is available',
    snippet: 'Receipt #4821 · $79.00 paid to OpenRouter…',
    priority: 'norm',
    priorityLabel: 'Normal',
    action: '可归档',
    read: true,
    unread: false,
    langPip: 'EN',
    avatar: 'ext',
  },
]

/** The currently-selected email's full AI Fields panel (reading-pane demo). */
export interface MockAIFields {
  emailId: string
  subject: string
  fromName: string
  fromDomain: string
  date: string
  model: string
  reviewed: boolean
  summary: string
  /** Reply suggestion as a short draft string (may include `code` spans). */
  draft: string
  priority: Priority
  priorityLabel: string
  action: string
  category: string
}

export const aiFields: MockAIFields = {
  emailId: 'e2',
  subject: '[Alert] webhook 8100: HTTP 502 from upstream',
  fromName: 'Sentry',
  fromDomain: 'sentry.io',
  date: '2026/05/29 · 14:08',
  model: 'claude-sonnet-5',
  reviewed: true,
  summary:
    'webhook 进程掉线导致上游 502，你是本次 oncall。建议给 update 调用加指数退避（3→9→27s）并重启进程。',
  draft: '已给 update 加 backoff（3→9→27s），进程已重启，prod 恢复。长期方案排到性能优化。',
  priority: 'crit',
  priorityLabel: 'Critical',
  action: 'Reply Needed',
  category: '系统告警',
}

/** Report list + selected report detail (/agents · daily digest). */
export interface MockReportCard {
  id: string
  date: string
  cadence: 'daily' | 'weekly' | 'monthly'
  cadenceLabel: string
  status: string
  title: string
  mailCount: number
  urgentCount: number
  selected?: boolean
}

export interface MockReportDetail {
  cadenceLabel: string
  model: string
  title: string
  dateRange: string
  overview: string
  stats: { value: string; key: string; accent?: boolean }[]
}

export const reportCards: MockReportCard[] = [
  {
    id: 'r1',
    date: '06/01',
    cadence: 'daily',
    cadenceLabel: '日报',
    status: '已就绪',
    title: '3 封紧急：PoC 排期 + 需求待拍板',
    mailCount: 32,
    urgentCount: 3,
    selected: true,
  },
  {
    id: 'r2',
    date: '05/31',
    cadence: 'weekly',
    cadenceLabel: '周报',
    status: '已就绪',
    title: 'W22：两大标案进入决策窗口',
    mailCount: 187,
    urgentCount: 12,
  },
  {
    id: 'r3',
    date: '05/31',
    cadence: 'monthly',
    cadenceLabel: '月报',
    status: '已就绪',
    title: '五月月报：PoC 进入决赛圈',
    mailCount: 742,
    urgentCount: 41,
  },
]

export const reportDetail: MockReportDetail = {
  cadenceLabel: '日报',
  model: 'claude-sonnet-5',
  title: '邮件日报',
  dateRange: '2026年6月1日 · 过去 24 小时',
  overview:
    '昨天共 32 封邮件，Jarvis 已自动处理 28 封；有 3 封紧急需要你亲自跟进，主要围绕 PoC 排期与一处需求锁定。其余多为系统通知与抄送知会，已归档。',
  stats: [
    { value: '32', key: '总邮件' },
    { value: '9', key: '未读' },
    { value: '3', key: '紧急', accent: true },
    { value: '28', key: 'AI' },
    { value: '4', key: '待你' },
  ],
}

/** AI chat transcript: a matter-scoped question, two tool calls, a cited answer. */
export interface MockChatTurn {
  role: 'you' | 'ai'
  text?: string
  /** AI turns may show a tool-call line + a cited answer. */
  tool?: string
  answer?: string
  source?: string
}

export const chat: MockChatTurn[] = [
  { role: 'you', text: '@M-042 这次 Northwind 的报价，和上一版差在哪？' },
  {
    role: 'ai',
    tool: '邮件搜索 · 12 封 → 读取资料库 · 报价对比.md',
    answer: '年付折扣从 12% 降到 8%，SLA 从 99.5% 提到 99.9%；差异集中在第 3 节服务条款，其余条款未变。',
    source: '来源：2 封邮件 · 1 份资料 ↗',
  },
]

export const chatEn: MockChatTurn[] = [
  { role: 'you', text: '@M-042 How does the new Northwind quote differ from the last one?' },
  {
    role: 'ai',
    tool: 'Mail search · 12 emails → Library read · quote-comparison.md',
    answer: 'The annual discount drops from 12% to 8%, and the SLA rises from 99.5% to 99.9%. The changes sit in section 3; the other terms are unchanged.',
    source: 'Sources: 2 emails · 1 file ↗',
  },
]

/** Mobile phone inbox (subset of emails). */
export const phoneEmails: MockEmail[] = emails.slice(0, 3)
