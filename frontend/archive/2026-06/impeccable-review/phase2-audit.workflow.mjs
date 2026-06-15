export const meta = {
  name: 'impeccable-frontend-audit',
  description: 'impeccable 按域审查 MailAgent frontend 实际实现（opus max effort，只读 Plan agent）',
  phases: [
    { title: 'Review', detail: '9 域并行 impeccable audit+critique（opus）', model: 'opus' },
    { title: 'Verify', detail: '逐域 adversarial 验证 findings（opus）', model: 'opus' },
  ],
}

const FE = '/Users/chenyuanquan/Documents/MailAgent/frontend'
const SHOT = FE + '/docs/impeccable-review'
const RUBRIC = SHOT + '/01-design-system-review.md'
const DESIGN = FE + '/DESIGN.md'
const CSS = FE + '/src/electron/renderer/index.css'

const DOMAINS = [
  { key: 'email', code: `${FE}/src/shared/components/email/ (14 组件) + index.css 的 .email-row/.avatar 段`,
    shots: ['live-inbox-01.png', 'live-inbox-mobile-390.png'],
    focus: 'EmailRow 虚拟列表/线程折叠/flag 三态/未读 dot/AI priority chip/详情正文 iframe。密度与对齐是该域核心价值。' },
  { key: 'ai-chat', code: `${FE}/src/shared/components/ai/ + ${FE}/src/shared/components/chat/ (13 组件)`,
    shots: ['live-inbox-01.png'],
    focus: 'AI chat panel/composer/message bubble/tool-call rows/draft preview card/quick action chips/backend selector。截图右栏是邮件详情非 AI panel，以代码 review 为主。' },
  { key: 'settings', code: `${FE}/src/shared/components/settings/ (22 组件) + index.css Settings 几何 SSoT 段`,
    shots: ['live-settings-desktop.png'],
    focus: '9-section nav rail IA/switch/radio/slider/accent swatch/EnvField/RemoteAccess/RestartBanner。Phase 1 标记此域 IA 无文档规范。' },
  { key: 'layout-chrome', code: `${FE}/src/shared/components/layout/ + keyboard/ + command/ (21 组件) + index.css .app-nav 段`,
    shots: ['live-inbox-01.png', 'live-inbox-mobile-390.png'],
    focus: 'NavShell collapse/TitleBar/StatusBar/三栏 grid/command palette ⌘K/快捷键 modal。响应式塌陷的主战场。' },
  { key: 'calendar', code: `${FE}/src/shared/components/calendar/ (14 组件)`,
    shots: ['live-calendar-desktop.png'],
    focus: '日/周/月/Agenda 视图/事件卡片/时间轴/空状态。DESIGN.md 零规范——全新视觉语言，重点查是否自造 token、与设计系统一致性。已知 F-CAL-ENVLEAK（空状态暴露 env 名）。' },
  { key: 'folder', code: `${FE}/src/shared/components/folder/ (7 组件)`,
    shots: ['live-archive-desktop.png'],
    focus: '存档/草稿箱列表/FolderSync 展示。DESIGN.md 零规范。与 email 列表的一致性/复用程度。' },
  { key: 'admin-dashboard', code: `${FE}/src/shared/components/llm/ + admin/ (3 组件)`,
    shots: ['live-kanban-desktop.png', 'live-llm-desktop.png'],
    focus: 'DavMail 健康卡/同步存储指标/状态分布 stacked bar/死信队列/LLM dashboard 图表。数据可视化 token 规范缺失（Phase 1 P3）——查图表配色是否复用 priority/sync ramp。' },
  { key: 'ui-primitives', code: `${FE}/src/shared/components/ui/ + feedback/ (14 组件) + Toast/ErrorBoundary/UpdateReadyBanner`,
    shots: ['live-settings-desktop.png'],
    focus: 'shadcn 扩展 primitive（button/badge/switch/select/slider/tabs/tooltip/dialog）。token 绑定/variant/focus ring/Radix data-state 动画一致性。是其他所有域的地基。' },
  { key: 'responsive-xcut', code: `横切：${FE}/src/shared/components/layout/ + 全局 index.css + 各域固定宽度用法`,
    shots: ['live-inbox-mobile-390.png', 'live-inbox-01.png', 'live-settings-desktop.png'],
    focus: '专审响应式（Phase 1 P0）。证据基线：响应式前缀 10/111、CSS min/max-width 断点 0、固定 px 宽度 75、390px inbox 三栏彻底 break。系统化定位：哪些组件硬编码宽度该流式化、侧栏 <lg 不 collapse、touch target<44、横向溢出、AI panel 窄屏策略缺失。给出断点系统 + 堆叠降级矩阵的具体落点。' },
]

const absShots = (d) => d.shots.map((s) => `${SHOT}/${s}`).join('\n  - ')

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string' },
    anti_pattern_verdict: { type: 'string', description: '本域是否有 AI slop tell，诚实判定' },
    scores: {
      type: 'object', additionalProperties: false,
      properties: {
        a11y: { type: 'integer' }, performance: { type: 'integer' }, theming: { type: 'integer' },
        responsive: { type: 'integer' }, antipattern: { type: 'integer' }, nielsen: { type: 'integer' },
      },
      required: ['a11y', 'performance', 'theming', 'responsive', 'antipattern', 'nielsen'],
    },
    strengths: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          category: { type: 'string', description: 'a11y|performance|theming|responsive|antipattern|nielsen|i18n|consistency' },
          file: { type: 'string', description: '精确到 file:line' },
          evidence: { type: 'string' }, impact: { type: 'string' },
          recommendation: { type: 'string' }, impeccable_command: { type: 'string' },
        },
        required: ['id', 'title', 'severity', 'category', 'file', 'evidence', 'impact', 'recommendation'],
      },
    },
  },
  required: ['domain', 'anti_pattern_verdict', 'scores', 'strengths', 'findings'],
}

const VERIFIED_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    domain: { type: 'string' },
    verified_findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          category: { type: 'string' }, file: { type: 'string' },
          evidence: { type: 'string' }, impact: { type: 'string' }, recommendation: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'downgraded', 'rejected'] },
          verdict_reason: { type: 'string' },
        },
        required: ['id', 'title', 'severity', 'category', 'file', 'recommendation', 'verdict', 'verdict_reason'],
      },
    },
  },
  required: ['domain', 'verified_findings'],
}

const reviewPrompt = (d) => `你是 impeccable 设计审查专家，对 MailAgent frontend 的「${d.key}」域做穷尽式 review。用 maximum effort、ultrathink、彻底深读——这是 opus 4.8 max-effort 审查，不要浅尝辄止。

## 只读铁律（违反即失败）
你**绝对禁止**修改/创建/删除任何文件，禁止任何 git/npm/pnpm 写命令或构建。只用 Read / Grep / Glob / 只读 Bash 调查。你的产出**只是结构化 findings**，不是改动。

## 背景
MailAgent = macOS Electron 邮件客户端 + web SPA（远程访问，已上线 dogfood）。设计系统极成熟：9 条 mailagent/* design lint 全 error、a11y:contrast=0 violations、token 三层解耦。所以**不要报设计系统已经用 lint 兜住的问题**（raw hex/banned color/大圆角/渐变/重阴影/灰阶 surface/coral flood/mono 字号塞中文/组件内 prefers-color-scheme 都已被 CI 挡）——除非你发现 lint 的**漏网路径**（inline style、SVG fill、动态拼 class、第三方组件）。

## 必读基准（先读，再 review）
1. Phase 1 设计系统 review + V2 rubric（§5 是 8 维 checklist，§4 是 V2 标准）：${RUBRIC}
2. 设计系统 SSoT（对照 drift，按需 Grep 章节，勿全读）：${DESIGN}
3. 全局 token/authored CSS：${CSS}

## 本域范围
- 代码：${d.code}
- live 截图（**务必 Read 做视觉 critique**，不能只看代码）：
  - ${absShots(d)}
- 域焦点：${d.focus}

## 已知全局 findings（供佐证，勿重复报，但可在本域补充实例）
- F-WEB-404：serve-api SPA 深链/刷新返回 FastAPI 404 JSON（history fallback 缺失）
- F-WEB-ATTACH：web 态邮件正文内联附件图片 404（/app/attachments/.../imageNNN.png）
- F-CAL-ENVLEAK：calendar 空状态把 CALENDAR_CALDAV_SYNC_ENABLED 暴露给用户
- 响应式真空：前缀 10/111、CSS 断点 0、固定宽度 75、390px inbox break

## 审查维度（全覆盖，impeccable audit + critique）
- **audit**：① a11y（focus ring 可见/键盘可达/ARIA/对比/color-not-only-signal）② 性能（无谓 re-render/layout thrash/动画掉帧/缺 memo/虚拟列表）③ theming（lint 漏网的硬编码色/inline style/SVG fill/light 态是否等价精修）④ 响应式（390/768/1024 是否 break/固定宽度该否流式/touch≥44）⑤ anti-pattern（嵌套卡片/重阴影/灰阶/新引入 AI tell）
- **critique**：Nielsen 10（重点 consistency/error-prevention/recognition/aesthetic-minimalist/error-recovery）· 认知负荷（决策点可见选项≤4？working memory？）· 空/错/加载/边界态完备性 · i18n（硬编码字符串=违反 DESIGN.md §16 硬约束）· accent 预算（本域 coral 用量是否超表面预算）· DESIGN.md 对齐（本域有无规范？实现 drift 方向——是文档滞后于优秀实现，还是实现偏离规范？）

## 输出要求（schema）
- anti_pattern_verdict：诚实判本域 AI slop（多数域应是"无 tell"，如实写）
- scores：6 维各 0-4（4=genuinely excellent，多数真实界面 2-3）
- strengths：2-4 个做得好、值得 celebrate + 向新域复制的点（要具体）
- findings：每个 id=${d.key.toUpperCase()}-NN，必含 file（精确 file:line）+ evidence（代码片段或截图观察）+ impact（对哪类用户/persona 的具体伤害）+ recommendation（具体可执行，不要"consider exploring"）+ severity P0-P3 + impeccable_command（adapt/animate/clarify/colorize/delight/distill/harden/layout/optimize/polish/quieter/typeset 之一）
- **宁缺勿滥**：只报能追溯到证据的真问题。P3 严格控量（太多 P3 = 噪音）。不报 false positive。`

const verifyPrompt = (d, review) => `你是 adversarial 验证者（opus，max effort，只读）。对「${d.key}」域 reviewer 提出的 ${review.findings.length} 个 findings 逐个**尝试反驳**。默认怀疑。

## 只读铁律
绝不修改任何文件。只用 Read/Grep 去代码与截图核实。

## 待验证 findings
${JSON.stringify(review.findings, null, 2)}

## 验证规则（逐个判 verdict）
- **confirmed**：去 file:line 核实证据成立、severity 合理
- **downgraded**：是真问题但 severity 被高估，调到合理级（写新 severity）
- **rejected**：① 证据不成立/file:line 对不上 ② false positive ③ 设计系统**有意为之**（如 DESIGN.md 明确规定、lint 允许、是专业工具刻意的密度/英文 mono 选择）④ 把"文档没写"误当"实现有错"
关键：MailAgent 是给单一 power user 的专业工具（非通用 SaaS），高信息密度、英文 mono section header、dark-first 都是**刻意设计**不是缺陷——凡把这些当问题的 finding 一律 rejected。响应式/web 态 404/附件 404/真实 a11y 缺陷/i18n 硬编码 是真问题应 confirmed。

## 必读（核实依据）
- ${DESIGN}（判断是否"有意为之"）
- ${RUBRIC}（V2 标准）
- 涉及的源码与截图（${SHOT}/）

## 输出
verified_findings：保留每个 finding 的 id/title/category/file/evidence/impact/recommendation，加 verdict + verdict_reason（一句话）+ 最终 severity。rejected 的也要列出（含 reason），不要静默丢弃。`

// ---- 执行：9 域 pipeline（review → adversarial verify），无 barrier ----
phase('Review')
const results = await pipeline(
  DOMAINS,
  (d) => agent(reviewPrompt(d), { label: `review:${d.key}`, phase: 'Review', model: 'opus', agentType: 'Plan', schema: FINDINGS_SCHEMA }),
  (review, d) => {
    if (!review || !Array.isArray(review.findings) || review.findings.length === 0) {
      return { domain: d.key, verified_findings: [], review }
    }
    return agent(verifyPrompt(d, review), { label: `verify:${d.key}`, phase: 'Verify', model: 'opus', agentType: 'Plan', schema: VERIFIED_SCHEMA })
      .then((v) => ({ ...(v || { domain: d.key, verified_findings: [] }), review }))
  },
)

const domains = results.filter(Boolean)
log(`完成 ${domains.length}/${DOMAINS.length} 域审查`)
return { domains }
