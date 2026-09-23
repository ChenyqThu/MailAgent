/**
 * Synthetic data for TodayMock (the Today surface). Every person, company,
 * matter and address here is fictional; addresses use the reserved `.example`
 * domain. Interface strings that exist in the product are copied verbatim from
 * frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json (`today.*`,
 * `agents.custom.runs.*`, `chat.approvalShell.*`, `matters.*`, `chat.toolTitle.*`);
 * the ICU placeholders are pre-filled.
 */

/** Token-derived tone (maps to a `--c-*` channel triple). */
export type TodayTone = 'accent' | 'info' | 'ok' | 'warn' | 'urg' | 'crit' | 'ai'

export interface TodaySection {
  title: string
  count: string
}

export interface TodayMockData {
  chrome: {
    kicker: string
    date: string
    title: string
    subtitle: string
    groupNeedYou: string
    groupNext: string
    sections: Record<'decide' | 'meet' | 'reply' | 'due' | 'out', TodaySection>
    replyMeta: string
    next: { label: string; left: string; pending: string }
    approval: { title: string; approve: string; editParams: string; reject: string }
    actions: { openMail: string; openCalendar: string; openReport: string }
  }
  decide: {
    run: { agent: string; trigger: string; ago: string; body: string; preview: string[] }
    proposal: { title: string; matter: string; meta: string }
  }
  meet: { time: string; title: string; sub: string; soon?: boolean }[]
  reply: { from: string; subject: string; count: string; age: string }[]
  due: { id: string; title: string; due: string; tone: TodayTone }[]
  out: { kind: 'report' | 'run'; title: string; why: string }[]
}

export const todayMock: Record<'zh-CN' | 'en', TodayMockData> = {
  'zh-CN': {
    chrome: {
      kicker: 'TODAY',
      date: '9月22日 周二',
      title: '今天',
      subtitle: '6 条等你看一眼',
      groupNeedYou: '需要你',
      groupNext: '接下来',
      sections: {
        decide: { title: '等你拍板', count: '2 条' },
        meet: { title: '今天的会', count: '2 条' },
        reply: { title: '待回邮件', count: '2 条' },
        due: { title: '临期事项', count: '2 条' },
        out: { title: '智能体产出', count: '2 条' },
      },
      replyMeta: '近 7 天 · 2 个线程',
      next: { label: '下一场 10:30', left: '还有 42 分钟', pending: '在那之前有 1 件要拍板' },
      approval: { title: '待审批', approve: '批准', editParams: '编辑参数', reject: '拒绝' },
      actions: { openMail: '去回复', openCalendar: '看日历', openReport: '看报告' },
    },
    decide: {
      run: {
        agent: '客户跟进',
        trigger: '由「邮件规则」触发 · 08:52',
        ago: '12 分钟前',
        body: '客户跟进 请求执行 起草回复，需要你批准。',
        preview: ['to: maya.lin@northwind.example', 'subject: Re: 欧洲区回滚窗口确认'],
      },
      proposal: {
        title: 'Agent 提案待评审',
        matter: 'M-042 · Q4 网关切换评审',
        meta: '3 项变更 · 置信度 82%',
      },
    },
    meet: [
      { time: '10:30', title: 'Q4 网关切换评审', sub: '还有 42 分钟 · Teams · 6 人', soon: true },
      { time: '14:00', title: '供应商季度复盘', sub: '3B 会议室 · 4 人' },
    ],
    reply: [
      { from: 'Maya Lin', subject: 'Re: 欧洲区回滚窗口确认', count: '3 封', age: '最久一封 2 天' },
      { from: 'Jonas Weber', subject: '沙箱证书续期', count: '1 封', age: '最久一封 5 小时' },
    ],
    due: [
      { id: 'M-037', title: '欧洲区 SLA 条款修订', due: '已逾期', tone: 'crit' },
      { id: 'M-051', title: 'Northwind 续约报价', due: '明天到期', tone: 'urg' },
    ],
    out: [
      { kind: 'report', title: '日报 · 9月22日', why: '日报，今天生成的' },
      { kind: 'run', title: '会前准备 · Q4 网关切换评审', why: '由「会前提醒」触发 · 09:30' },
    ],
  },
  en: {
    chrome: {
      kicker: 'TODAY',
      date: 'Tue, Sep 22',
      title: 'Today',
      subtitle: '6 items to look at',
      groupNeedYou: 'Needs you',
      groupNext: 'Up next',
      sections: {
        decide: { title: 'Your call', count: '2 items' },
        meet: { title: "Today's meetings", count: '2 items' },
        reply: { title: 'Emails to answer', count: '2 items' },
        due: { title: 'Due soon', count: '2 items' },
        out: { title: 'Agent output', count: '2 items' },
      },
      replyMeta: 'Last 7 days · 2 threads',
      next: { label: 'Next 10:30', left: '42 min left', pending: '1 call to make before then' },
      approval: { title: 'Approval pending', approve: 'Approve', editParams: 'Edit parameters', reject: 'Deny' },
      actions: { openMail: 'Reply', openCalendar: 'Open calendar', openReport: 'Open report' },
    },
    decide: {
      run: {
        agent: 'Client follow-up',
        trigger: 'Triggered by mail rule · 08:52',
        ago: '12m ago',
        body: 'Client follow-up wants to run Draft reply — your approval is required.',
        preview: ['to: maya.lin@northwind.example', 'subject: Re: EU rollback window'],
      },
      proposal: {
        title: 'Agent proposal to review',
        matter: 'M-042 · Q4 gateway cutover review',
        meta: '3 changes · 82% confidence',
      },
    },
    meet: [
      { time: '10:30', title: 'Q4 gateway cutover review', sub: '42 min left · Teams · 6 people', soon: true },
      { time: '14:00', title: 'Supplier quarterly review', sub: 'Room 3B · 4 people' },
    ],
    reply: [
      { from: 'Maya Lin', subject: 'Re: EU rollback window', count: '3', age: 'Oldest 2d' },
      { from: 'Jonas Weber', subject: 'Sandbox certificate renewal', count: '1', age: 'Oldest 5h' },
    ],
    due: [
      { id: 'M-037', title: 'EU SLA terms revision', due: 'Overdue', tone: 'crit' },
      { id: 'M-051', title: 'Northwind renewal quote', due: 'Due tomorrow', tone: 'urg' },
    ],
    out: [
      { kind: 'report', title: 'Daily report · Sep 22', why: 'Daily, generated today' },
      { kind: 'run', title: 'Meeting prep · Q4 gateway cutover review', why: 'Triggered by pre-meeting · 09:30' },
    ],
  },
}
