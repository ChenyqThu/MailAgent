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
  model: 'claude-sonnet-4-6',
  reviewed: true,
  summary:
    'webhook 进程掉线导致上游 502，你是本次 oncall。建议给 update 调用加指数退避（3→9→27s）并重启进程。',
  draft: '已给 update 加 backoff（3→9→27s），进程已重启，prod 恢复。长期方案排到性能优化。',
  priority: 'crit',
  priorityLabel: 'Critical',
  action: 'Reply Needed',
  category: '系统告警',
}

/** Ping Island live-activity payload. */
export interface MockIslandItem {
  avatarInitials: string
  avatarColor: string
  priority: Priority
  priorityLabel: string
  sender: string
  title: string
  subtitle: string
  actions: string[]
}

export const island: MockIslandItem = {
  avatarInitials: 'AR',
  avatarColor: 'rgb(248 138 125)',
  priority: 'crit',
  priorityLabel: 'CRITICAL',
  sender: 'Alex Rivera · northwind.io',
  title: 'Re: 多区域部署 — 关于 rate limit',
  subtitle: '需要决策 · 建议给 webhook 加指数退避，并三端统一新用户引导。',
  actions: ['打开', '稍后', '归档'],
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
  model: 'claude-sonnet-4-6',
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

/** Custom AI / KOS chat transcript. */
export interface MockChatTurn {
  role: 'you' | 'ai'
  text?: string
  /** AI turns may show a tool-call line + a cited answer. */
  tool?: string
  answer?: string
  source?: string
}

export const chat: MockChatTurn[] = [
  { role: 'you', text: '这个供应商以前的合同条款是什么？' },
  {
    role: 'ai',
    tool: 'KOS → query · find_trajectory · sources/email/*',
    answer: '上一版合同（2025-11）约定 24 个月、按年付，附 SLA 99.5%。',
    source: '来源：3 封邮件 ↗',
  },
]

/** LLM dashboard stats. */
export interface MockDashboard {
  range: '7d' | '30d' | '90d'
  cards: { key: string; value: string; sub: string; accent?: boolean }[]
  status: { total: number; success: number; pending: number }
  cacheHitRate: number
  cacheTarget: number
  cacheWrite: string
  cacheRead: string
}

export const dashboard: MockDashboard = {
  range: '7d',
  cards: [
    { key: 'Processed · 7d', value: '5,904', sub: '5,894 success', accent: true },
    { key: 'Input tokens', value: '1.11M', sub: '1,110,396' },
    { key: 'Output tokens', value: '415.8K', sub: '415,819' },
    { key: 'Avg latency', value: '42.5s', sub: 'over 5,894 ok' },
  ],
  status: { total: 5904, success: 5894, pending: 10 },
  cacheHitRate: 5.0,
  cacheTarget: 70,
  cacheWrite: '856.1K',
  cacheRead: '3.16M',
}

/** Top-line stats band (Observability). */
export const observabilityStats = [
  { value: '5,904', key: 'Processed · 7d', sub: '近 7 天处理量' },
  { value: '1.11M', key: 'Input tokens', sub: '输入 token' },
  { value: '42.5s', key: 'Avg latency', sub: '平均耗时 / 封' },
  { value: '9,311', key: 'Synced mail', sub: '同步邮件总数' },
]

/** Mobile phone inbox (subset of emails + island ping). */
export const phoneEmails: MockEmail[] = emails.slice(0, 3)
