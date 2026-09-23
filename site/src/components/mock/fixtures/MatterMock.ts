/**
 * Synthetic data for MatterMock (a matter's detail page). Every person,
 * company and matter here is fictional. Interface strings that exist in the
 * product are copied verbatim from
 * frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json (`matters.*`);
 * the ICU placeholders are pre-filled.
 */

/** Token-derived tone (maps to a `--c-*` channel triple). */
export type MatterTone = 'accent' | 'info' | 'ok' | 'warn' | 'urg' | 'impt' | 'ai' | 'crit'

export interface MatterActionItem {
  title: string
  /** agent = dispatched and running; waiting = waiting on a person; done. */
  state: 'agent' | 'waiting' | 'done'
  stateLabel: string
  meta: string
}

export interface MatterProgressItem {
  kind: string
  tone: MatterTone
  time: string
  text: string
  ref?: string
}

export interface MatterMockData {
  chrome: {
    background: string
    goal: string
    criteria: string
    criteriaCount: string
    actions: string
    stakeholders: string
    core: string
    progress: string
    followup: string
  }
  matter: {
    id: string
    title: string
    status: string
    health: string
    due: string
    tags: string[]
  }
  background: string
  goal: string
  criteria: { text: string; done: boolean }[]
  actions: MatterActionItem[]
  stakeholders: { name: string; initials: string; tone: MatterTone; role: string; org: string; waiting?: string }[]
  progress: { day: string; items: MatterProgressItem[] }[]
  proposal: { title: string; summary: string; meta: string; reject: string; accept: string }
}

export const matterMock: Record<'zh-CN' | 'en', MatterMockData> = {
  'zh-CN': {
    chrome: {
      background: '背景',
      goal: '目标',
      criteria: '完成标志',
      criteriaCount: '已完成 2 / 4',
      actions: '行动项',
      stakeholders: '干系人',
      core: '核心干系人',
      progress: '事情的进展',
      followup: '跟进 Agent',
    },
    matter: {
      id: 'M-042',
      title: 'Q4 网关切换评审',
      status: '进行中',
      health: '有风险',
      due: '截止 10月9日',
      tags: ['支付', 'Northwind'],
    },
    background:
      '北美与欧洲两区的支付网关要在 Q4 切到新供应商。Northwind 要求切换前做一次联合评审，并事先约定回滚窗口。',
    goal: '两区按计划切换；切换当周的交易失败率不高于现在。',
    criteria: [
      { text: '评审议程双方确认', done: true },
      { text: '北美区切换方案定稿', done: true },
      { text: '欧洲区回滚窗口通过法务复核', done: false },
      { text: '评审纪要双方签字', done: false },
    ],
    actions: [
      {
        title: '整理三家网关的切换风险对照',
        state: 'agent',
        stateLabel: '执行中',
        meta: '内建跟进 Agent · 第 1 轮',
      },
      {
        title: '确认欧洲区回滚窗口',
        state: 'waiting',
        stateLabel: '等待中',
        meta: '等待 Maya Lin · 10月1日到期',
      },
      {
        title: '发出评审议程',
        state: 'done',
        stateLabel: '已完成',
        meta: '9月19日',
      },
    ],
    stakeholders: [
      { name: 'Daniel Cho', initials: 'DC', tone: 'ok', role: '决策人', org: 'Northwind' },
      { name: 'Maya Lin', initials: 'ML', tone: 'info', role: '执行人', org: 'Northwind', waiting: '等待中' },
      { name: 'Priya Nair', initials: 'PN', tone: 'urg', role: '审批人', org: 'Northwind' },
    ],
    progress: [
      {
        day: '今天',
        items: [
          { kind: '信号', tone: 'warn', time: '09:14', text: 'Maya 回邮：回滚窗口需要法务复核', ref: '邮件' },
        ],
      },
      {
        day: '昨天',
        items: [
          { kind: '决议', tone: 'accent', time: '16:40', text: '先切北美区，欧洲区顺延一周' },
          { kind: '里程碑', tone: 'ok', time: '11:05', text: '评审议程双方确认', ref: '邮件' },
        ],
      },
    ],
    proposal: {
      title: '跟进 Agent 提出了 3 项变化，等待你审阅',
      summary: '把「确认欧洲区回滚窗口」的截止改到 10月3日，新增行动项「约法务复核」，并记一条进展。',
      meta: '置信 82%',
      reject: '拒绝',
      accept: '全部接受',
    },
  },
  en: {
    chrome: {
      background: 'Background',
      goal: 'Goal',
      criteria: 'Completion criteria',
      criteriaCount: '2 of 4 done',
      actions: 'Action items',
      stakeholders: 'Stakeholders',
      core: 'Core stakeholders',
      progress: 'Progress',
      followup: 'Follow-up agent',
    },
    matter: {
      id: 'M-042',
      title: 'Q4 gateway cutover review',
      status: 'Active',
      health: 'At risk',
      due: 'Due Oct 9',
      tags: ['Payments', 'Northwind'],
    },
    background:
      'The North America and EU payment gateways move to a new provider in Q4. Northwind wants a joint review before cutover, with a rollback window agreed in advance.',
    goal: 'Both regions cut over on schedule, with cutover-week transaction failures no higher than today.',
    criteria: [
      { text: 'Review agenda confirmed by both sides', done: true },
      { text: 'North America cutover plan final', done: true },
      { text: 'EU rollback window cleared by legal', done: false },
      { text: 'Review minutes signed by both sides', done: false },
    ],
    actions: [
      {
        title: 'Compare cutover risks across the three gateways',
        state: 'agent',
        stateLabel: 'Running',
        meta: 'Built-in follow-up agent · Round 1',
      },
      {
        title: 'Confirm the EU rollback window',
        state: 'waiting',
        stateLabel: 'Waiting',
        meta: 'Waiting on Maya Lin · Due Oct 1',
      },
      {
        title: 'Send the review agenda',
        state: 'done',
        stateLabel: 'Done',
        meta: 'Sep 19',
      },
    ],
    stakeholders: [
      { name: 'Daniel Cho', initials: 'DC', tone: 'ok', role: 'Decision maker', org: 'Northwind' },
      { name: 'Maya Lin', initials: 'ML', tone: 'info', role: 'Owner', org: 'Northwind', waiting: 'Waiting' },
      { name: 'Priya Nair', initials: 'PN', tone: 'urg', role: 'Approver', org: 'Northwind' },
    ],
    progress: [
      {
        day: 'Today',
        items: [
          {
            kind: 'Signal',
            tone: 'warn',
            time: '09:14',
            text: 'Maya replied: the rollback window needs legal review',
            ref: 'Email',
          },
        ],
      },
      {
        day: 'Yesterday',
        items: [
          { kind: 'Decision', tone: 'accent', time: '16:40', text: 'North America cuts over first; EU follows a week later' },
          { kind: 'Milestone', tone: 'ok', time: '11:05', text: 'Review agenda confirmed by both sides', ref: 'Email' },
        ],
      },
    ],
    proposal: {
      title: 'The follow-up agent proposed 3 changes for review',
      summary:
        'Move "Confirm the EU rollback window" to Oct 3, add the action item "Book a legal review", and note one progress entry.',
      meta: 'Confidence 82%',
      reject: 'Reject',
      accept: 'Accept all',
    },
  },
}
