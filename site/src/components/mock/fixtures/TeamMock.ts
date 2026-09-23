/**
 * Synthetic data for TeamMock (the Team page). Every company, person and run
 * here is fictional. Interface strings that exist in the product are copied
 * verbatim from frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json
 * (`nav.domain.team`, `team.list.*`, `team.tabs.*`, `team.record.trigger.*`,
 * `team.detail.*`, `chat.thinking.label`, `settings.ai.notionAgent.primaryTag`);
 * the ICU placeholders are pre-filled.
 */

/** Avatar silhouette — each team member gets a different one. */
export type AvatarShape = 'squircle' | 'circle' | 'hex' | 'capsule' | 'diamond' | 'arch'

/** Token-derived tone (maps to a `--c-*` channel triple). */
export type TeamTone = 'accent' | 'info' | 'ok' | 'impt' | 'ai' | 'urg'

export interface TeamMember {
  name: string
  sub: string
  shape: AvatarShape
  tone: TeamTone
  working?: boolean
  selected?: boolean
}

export interface TeamToolStep {
  label: string
  detail: string
  took: string
}

export interface TeamMockData {
  chrome: {
    title: string
    primaryTag: string
    builtin: string
    custom: string
    newAgent: string
    tabs: { chat: string; record: string; settings: string }
    triggerBadge: string
    triggerLabel: string
    thinkingLabel: string
    outputLabel: string
    steps: string
    tokens: string
    duration: string
  }
  main: TeamMember
  builtin: TeamMember[]
  custom: TeamMember[]
  run: {
    agentSub: string
    title: string
    source: string
    trigger: string
    thinking: string
    tools: TeamToolStep[]
    output: string
    file: string
    stats: { steps: string; tokens: string; duration: string }
  }
}

export const teamMock: Record<'zh-CN' | 'en', TeamMockData> = {
  'zh-CN': {
    chrome: {
      title: '团队',
      primaryTag: '主 Agent',
      builtin: '内置',
      custom: '自定义',
      newAgent: '新建智能体',
      tabs: { chat: '对话', record: '执行', settings: '设置' },
      triggerBadge: '会前触发',
      triggerLabel: '触发',
      thinkingLabel: '思考过程',
      outputLabel: '输出',
      steps: '步数',
      tokens: 'Token',
      duration: '用时',
    },
    main: { name: 'Jarvis', sub: '工作中', shape: 'squircle', tone: 'accent', working: true },
    builtin: [
      { name: '邮件日报', sub: '每天 09:00', shape: 'circle', tone: 'info' },
      { name: '搜索', sub: '⌘K 命令面板', shape: 'hex', tone: 'ok' },
      { name: '邮件预处理', sub: '收信时逐封分类', shape: 'capsule', tone: 'impt' },
    ],
    custom: [
      { name: '会前准备', sub: '会前 1 天', shape: 'diamond', tone: 'ai', selected: true },
      { name: '事项跟进', sub: '按事项规则', shape: 'arch', tone: 'urg' },
    ],
    run: {
      agentSub: '自定义 · 日历触发',
      title: 'Northwind 周会 · 会前准备',
      source: '日历 · 会前 1 天 · 周一 10:00',
      trigger: 'Northwind 周会 · 9月22日 周二 10:00 · 3 位参会人',
      thinking: '会在明早 10:00。先确认参会人，再翻近两周与 Maya Lin 的往来，把没结的问题和要带的材料写成一页。',
      tools: [
        { label: '读取日程', detail: 'Northwind 周会 · 3 位参会人', took: '0.3s' },
        { label: '检索邮件', detail: 'Maya Lin、Daniel Cho · 近 14 天 · 12 封', took: '1.2s' },
        { label: '检索资料库', detail: '渠道伙伴 报价 · 2 个文件', took: '0.6s' },
        { label: '写入资料库', detail: 'Agents 文档 / 会前准备 / 会前准备 · Northwind 周会.md', took: '0.1s' },
      ],
      output: '已为 Northwind 周会整理 3 份材料',
      file: '会前准备 · Northwind 周会.md',
      stats: { steps: '7', tokens: '输入 18.4k · 输出 2.1k', duration: '42 秒' },
    },
  },
  en: {
    chrome: {
      title: 'Team',
      primaryTag: 'Main',
      builtin: 'Built-in',
      custom: 'Custom',
      newAgent: 'New agent',
      tabs: { chat: 'Chat', record: 'Runs', settings: 'Settings' },
      triggerBadge: 'Triggered before a meeting',
      triggerLabel: 'Trigger',
      thinkingLabel: 'Thinking',
      outputLabel: 'Output',
      steps: 'Steps',
      tokens: 'Tokens',
      duration: 'Duration',
    },
    main: { name: 'Jarvis', sub: 'Working', shape: 'squircle', tone: 'accent', working: true },
    builtin: [
      { name: 'Daily mail digest', sub: 'Daily at 09:00', shape: 'circle', tone: 'info' },
      { name: 'Search', sub: '⌘K palette', shape: 'hex', tone: 'ok' },
      { name: 'Mail preprocessing', sub: 'Classifies new mail', shape: 'capsule', tone: 'impt' },
    ],
    custom: [
      { name: 'Meeting prep', sub: '1 day before', shape: 'diamond', tone: 'ai', selected: true },
      { name: 'Matter follow-up', sub: 'Per-matter rules', shape: 'arch', tone: 'urg' },
    ],
    run: {
      agentSub: 'Custom · calendar trigger',
      title: 'Northwind weekly · meeting prep',
      source: 'Calendar · 1 day before · Mon 10:00',
      trigger: 'Northwind weekly · Tue, Sep 22 · 10:00 · 3 attendees',
      thinking:
        'The meeting is tomorrow at 10:00. Confirm attendees, go through the last two weeks with Maya Lin, then put open issues and materials on one page.',
      tools: [
        { label: 'Read event', detail: 'Northwind weekly · 3 attendees', took: '0.3s' },
        { label: 'Search mail', detail: 'Maya Lin, Daniel Cho · last 14 days · 12 messages', took: '1.2s' },
        { label: 'Search library', detail: 'channel partner pricing · 2 files', took: '0.6s' },
        { label: 'Write to library', detail: 'Agent docs / Meeting prep / Meeting prep · Northwind weekly.md', took: '0.1s' },
      ],
      output: 'Prepared 3 documents for the Northwind weekly',
      file: 'Meeting prep · Northwind weekly.md',
      stats: { steps: '7', tokens: 'in 18.4k · out 2.1k', duration: '42s' },
    },
  },
}
