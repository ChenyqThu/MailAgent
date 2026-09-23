/**
 * Synthetic data for ContactMock (the Contacts person page). Every person,
 * company and address here is fictional; addresses use the reserved
 * `.example` domain. Interface strings that exist in the product are copied
 * verbatim from frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json
 * (`contacts.*`); the ICU placeholders are pre-filled.
 */

/** Token-derived monogram tone (maps to a `--c-*` channel triple). */
export type MonoTone = 'accent' | 'info' | 'ok' | 'urg' | 'impt' | 'ai' | 'crit'

export interface ContactListRow {
  name: string
  org: string
  tone: MonoTone
  selected?: boolean
}

export interface ContactEvidence {
  /** Fake internal_id — the product's evidence badge carries the email id. */
  id: number
  subject: string
}

/** Text run: plain string, or an evidence badge after the preceding text. */
export type ProfileRun = string | ContactEvidence

export interface ContactEvolutionItem {
  at: string
  text: string
  ev: ContactEvidence
}

export interface ContactMockData {
  chrome: {
    listTitle: string
    listCount: string
    searchPlaceholder: string
    compose: string
    primary: string
    former: string
    emailsTitle: string
    orgTitle: string
    manager: string
    peers: string
    autoSrc: string
    profileTitle: string
    profileBasis: string
    topics: string
    projects: string
    evolution: string
    evidenceLabel: string
  }
  person: {
    name: string
    formalName: string
    initials: string
    tone: MonoTone
    subtitle: string
    fnLevel: string
    exchange: string
    since: string
    sent: number
    total: number
    emails: { address: string; count: number; primary?: boolean; former?: boolean }[]
  }
  manager: { name: string; initials: string; tone: MonoTone; sub: string }
  peers: { name: string; initials: string; tone: MonoTone }[]
  profile: {
    summary: ProfileRun[]
    topics: string[]
    projects: string[]
    evolution: ContactEvolutionItem[]
  }
  list: ContactListRow[]
}

const EV = {
  first: 10231,
  switch: 14870,
  cc: 21544,
  proposal: 20917,
  cutover: 21302,
}

export const contactMock: Record<'zh-CN' | 'en', ContactMockData> = {
  'zh-CN': {
    chrome: {
      listTitle: '通讯录',
      listCount: '128 人',
      searchPlaceholder: '搜索姓名 / 名字变体 / 邮箱 / 组织',
      compose: '写邮件',
      primary: '主邮箱',
      former: '曾用',
      emailsTitle: '邮箱锚点',
      orgTitle: '组织关系',
      manager: '上级',
      peers: '同组织同事（自动归类，不是手工关系）',
      autoSrc: '从邮件推断',
      profileTitle: 'AI 画像',
      profileBasis: '基于 214 封邮件 · 3 天前',
      topics: '常聊议题',
      projects: '共同项目',
      evolution: '人物轨迹',
      evidenceLabel: '证据',
    },
    person: {
      name: 'Maya Lin',
      formalName: '林美雅',
      initials: 'ML',
      tone: 'info',
      subtitle: 'Northwind · 平台部 / 支付组 · 高级产品经理',
      fnLevel: '产品 · 负责人',
      exchange: '往来 214 封 · 我发出 86',
      since: '2024年3月 起 · 最近 2 天前',
      sent: 86,
      total: 214,
      emails: [
        { address: 'maya.lin@northwind.example', count: 188, primary: true },
        { address: 'maya.lin@fabrikam.example', count: 26, former: true },
      ],
    },
    manager: {
      name: 'Daniel Cho',
      initials: 'DC',
      tone: 'ok',
      sub: 'Northwind · 平台部 · 产品副总裁',
    },
    peers: [
      { name: 'Priya Nair', initials: 'PN', tone: 'urg' },
      { name: 'Tom Becker', initials: 'TB', tone: 'impt' },
      { name: 'Lena Wu', initials: 'LW', tone: 'accent' },
      { name: 'Omar Haddad', initials: 'OH', tone: 'ai' },
    ],
    profile: {
      summary: [
        'Northwind 支付组的产品负责人，与你的往来集中在结算 API 迁移和欧洲区上线。',
        { id: EV.switch, subject: 'Re: 结算 API v2 迁移时间表' },
        '做决定前习惯先要一份书面方案，常把法务与财务一并抄送。',
        { id: EV.proposal, subject: '欧洲区上线：SLA 条款修订稿' },
        '近两个月在推进 Q4 网关切换的评审排期。',
        { id: EV.cutover, subject: 'Q4 网关切换评审 · 议程确认' },
      ],
      topics: ['结算 API 迁移', '欧洲区上线', 'SLA 条款'],
      projects: ['Q4 网关切换', 'Northwind 续约'],
      evolution: [
        {
          at: '2024-03',
          text: '以 Fabrikam 合作方身份首次来信，商量接口对接',
          ev: { id: EV.first, subject: '接口对接：沙箱环境申请' },
        },
        {
          at: '2025-06',
          text: '改用 Northwind 邮箱，署名换成支付组产品经理',
          ev: { id: EV.switch, subject: 'Re: 结算 API v2 迁移时间表' },
        },
        {
          at: '2026-08',
          text: '牵头 Q4 网关切换评审，开始抄送 Daniel Cho',
          ev: { id: EV.cc, subject: 'Q4 网关切换：评审人名单' },
        },
      ],
    },
    list: [
      { name: 'Maya Lin', org: 'Northwind', tone: 'info', selected: true },
      { name: 'Daniel Cho', org: 'Northwind', tone: 'ok' },
      { name: 'Priya Nair', org: 'Northwind', tone: 'urg' },
      { name: 'Jonas Weber', org: 'Fabrikam', tone: 'crit' },
      { name: 'Tom Becker', org: 'Northwind', tone: 'impt' },
      { name: 'Aiko Tanaka', org: 'Contoso', tone: 'accent' },
      { name: 'Lena Wu', org: 'Northwind', tone: 'accent' },
      { name: 'Omar Haddad', org: 'Northwind', tone: 'ai' },
      { name: 'Sofia Rossi', org: 'Litware', tone: 'ok' },
    ],
  },
  en: {
    chrome: {
      listTitle: 'Contacts',
      listCount: '128 people',
      searchPlaceholder: 'Search name, alias, email or org',
      compose: 'New email',
      primary: 'Primary',
      former: 'Former',
      emailsTitle: 'Email anchors',
      orgTitle: 'Reporting',
      manager: 'Manager',
      peers: 'Colleagues (derived, not curated)',
      autoSrc: 'Inferred from mail',
      profileTitle: 'AI profile',
      profileBasis: 'From 214 messages · 3d ago',
      topics: 'Recurring topics',
      projects: 'Shared projects',
      evolution: 'Trajectory',
      evidenceLabel: 'Evidence',
    },
    person: {
      name: 'Maya Lin',
      formalName: 'Lin Mei-ya',
      initials: 'ML',
      tone: 'info',
      subtitle: 'Northwind · Platform / Payments · Senior Product Manager',
      fnLevel: 'Product · Lead',
      exchange: '214 messages · 86 sent by me',
      since: 'Since Mar 2024 · last 2d ago',
      sent: 86,
      total: 214,
      emails: [
        { address: 'maya.lin@northwind.example', count: 188, primary: true },
        { address: 'maya.lin@fabrikam.example', count: 26, former: true },
      ],
    },
    manager: {
      name: 'Daniel Cho',
      initials: 'DC',
      tone: 'ok',
      sub: 'Northwind · Platform · VP, Product',
    },
    peers: [
      { name: 'Priya Nair', initials: 'PN', tone: 'urg' },
      { name: 'Tom Becker', initials: 'TB', tone: 'impt' },
      { name: 'Lena Wu', initials: 'LW', tone: 'accent' },
      { name: 'Omar Haddad', initials: 'OH', tone: 'ai' },
    ],
    profile: {
      summary: [
        'Product lead for payments at Northwind. Your threads with her center on the settlement API migration and the EU launch.',
        { id: EV.switch, subject: 'Re: Settlement API v2 migration timeline' },
        ' She asks for a written proposal before deciding, and usually copies legal and finance.',
        { id: EV.proposal, subject: 'EU launch: revised SLA terms' },
        ' For the past two months she has been scheduling the Q4 gateway cutover review.',
        { id: EV.cutover, subject: 'Q4 gateway cutover review · agenda' },
      ],
      topics: ['Settlement API migration', 'EU launch', 'SLA terms'],
      projects: ['Q4 gateway cutover', 'Northwind renewal'],
      evolution: [
        {
          at: '2024-03',
          text: 'First wrote in as a Fabrikam partner about the API integration',
          ev: { id: EV.first, subject: 'API integration: sandbox access' },
        },
        {
          at: '2025-06',
          text: 'Moved to a Northwind address; signs as payments PM',
          ev: { id: EV.switch, subject: 'Re: Settlement API v2 migration timeline' },
        },
        {
          at: '2026-08',
          text: 'Leads the Q4 cutover review; now copies Daniel Cho',
          ev: { id: EV.cc, subject: 'Q4 gateway cutover: reviewer list' },
        },
      ],
    },
    list: [
      { name: 'Maya Lin', org: 'Northwind', tone: 'info', selected: true },
      { name: 'Daniel Cho', org: 'Northwind', tone: 'ok' },
      { name: 'Priya Nair', org: 'Northwind', tone: 'urg' },
      { name: 'Jonas Weber', org: 'Fabrikam', tone: 'crit' },
      { name: 'Tom Becker', org: 'Northwind', tone: 'impt' },
      { name: 'Aiko Tanaka', org: 'Contoso', tone: 'accent' },
      { name: 'Lena Wu', org: 'Northwind', tone: 'accent' },
      { name: 'Omar Haddad', org: 'Northwind', tone: 'ai' },
      { name: 'Sofia Rossi', org: 'Litware', tone: 'ok' },
    ],
  },
}
