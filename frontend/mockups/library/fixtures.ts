// 假数据。形状照 design §1.2 的 `library_file` / `library_mount` / `library_history`，
// 字段名逐字对齐，落地时只换数据源不换渲染层。
//
// 覆盖面（刻意铺开，好检查每个取值都有像样的呈现）：
//   kind        markdown | html | pdf | office | image | text | video | placeholder | other
//   source      user | mail | chat | agent | derived
//   status      present | missing | trashed
//   text_status pending | extracted | failed | unsupported | null（图片无 OCR 时）
//   created_by  'user' | agent_id
//   mount       内置四根 + rw 挂载 + ro 挂载 + unavailable 挂载

export type LibKind =
  | 'markdown'
  | 'html'
  | 'pdf'
  | 'office'
  | 'image'
  | 'text'
  | 'video'
  | 'placeholder'
  | 'other'

export type LibSource = 'user' | 'mail' | 'chat' | 'agent' | 'derived'
export type LibStatus = 'present' | 'missing' | 'trashed'
export type LibTextStatus = 'pending' | 'extracted' | 'failed' | 'unsupported' | null

export interface LibFile {
  id: number
  rel_path: string
  parent_path: string
  filename: string
  /** md 的 frontmatter.title —— 列表「名称」列优先显示它，回落 filename。 */
  title?: string
  kind: LibKind
  size_bytes: number | null
  mtime: string
  content_hash: string
  source: LibSource
  /** mail: 邮件主题 + 发件人；chat: 会话标题；agent: agent 名；derived: 原文件名。 */
  source_ref?: string
  created_by: string
  status: LibStatus
  text_status: LibTextStatus
  /** 预览用的正文（markdown / 解析版 / 纯文本）。 */
  body?: string
  /** office / pdf 的解析器名（design §1.2 `library_text.extractor`）。 */
  extractor?: string
  truncated?: boolean
  /** 废纸篓行剩余天数。 */
  trashDaysLeft?: number
  /** 关联的事项（反查，design §9.2）。 */
  matters?: string[]
}

export interface LibMount {
  id: number
  label: string
  abs_path: string
  mode: 'ro' | 'rw'
  status: 'ok' | 'unavailable'
  fileCount: number
  added_at: string
}

export interface LibHistoryRow {
  id: number
  changed_by: string
  change_note: string | null
  created_at: string
  size_bytes: number
  delta: number
  snapshot: string
}

// ── 挂载 ──────────────────────────────────────────────────────────────
export const MOUNTS: LibMount[] = [
  {
    id: 1,
    label: '工作区',
    abs_path: '/Users/chenyuanquan/Documents/Omada/工作区',
    mode: 'rw',
    status: 'ok',
    fileCount: 1284,
    added_at: '2026-08-21T10:12:00+08:00'
  },
  {
    id: 2,
    label: 'Design 素材',
    abs_path: '/Users/chenyuanquan/Design/assets',
    mode: 'ro',
    status: 'ok',
    fileCount: 3702,
    added_at: '2026-08-28T09:40:00+08:00'
  },
  {
    id: 3,
    label: '移动硬盘',
    abs_path: '/Volumes/T7/archive-2025',
    mode: 'ro',
    status: 'unavailable',
    fileCount: 8810,
    added_at: '2026-07-03T15:22:00+08:00'
  }
]

// ── 文件夹（parent_path → 子文件夹）。虚拟路径恒 `<根 slug>/<相对路径>`。 ──
export interface LibFolder {
  path: string
  name: string
  /** 直接子文件数（角标）。 */
  count: number
  readonly?: boolean
  /** 挂载根不可用时整棵树灰显。 */
  unavailable?: boolean
}

export const FOLDERS: LibFolder[] = [
  // 投影区：按 {YYYY-MM} 分组，只读
  { path: 'mail-attachments', name: '邮件附件', count: 0, readonly: true },
  { path: 'mail-attachments/2026-08', name: '2026-08', count: 34, readonly: true },
  { path: 'mail-attachments/2026-07', name: '2026-07', count: 51, readonly: true },
  { path: 'mail-attachments/2026-06', name: '2026-06', count: 28, readonly: true },
  // 对话附件
  { path: 'chat-attachments', name: '对话附件', count: 0 },
  { path: 'chat-attachments/2026-09', name: '2026-09', count: 3 },
  { path: 'chat-attachments/2026-08', name: '2026-08', count: 12 },
  // Agents 文档
  { path: 'agent-docs', name: 'Agents 文档', count: 1 },
  { path: 'agent-docs/notes', name: 'notes', count: 6 },
  { path: 'agent-docs/sources', name: 'sources', count: 4 },
  { path: 'agent-docs/reports', name: 'reports', count: 2 },
  { path: 'agent-docs/meeting-prep', name: 'meeting-prep', count: 0 },
  // 我的文档
  { path: 'my-docs', name: '我的文档', count: 2 },
  { path: 'my-docs/合同', name: '合同', count: 5 },
  { path: 'my-docs/产品', name: '产品', count: 7 },
  { path: 'my-docs/产品/定价', name: '定价', count: 3 },
  // 挂载根
  { path: '@工作区', name: '@工作区', count: 3 },
  { path: '@工作区/2026-Q3', name: '2026-Q3', count: 18 },
  { path: '@工作区/招投标', name: '招投标', count: 9 },
  { path: '@Design 素材', name: '@Design 素材', count: 0, readonly: true },
  { path: '@Design 素材/brand', name: 'brand', count: 62, readonly: true },
  { path: '@移动硬盘', name: '@移动硬盘', count: 0, readonly: true, unavailable: true },
  // 废纸篓
  { path: '.trash', name: '废纸篓', count: 3 }
]

const MD_PRICING = `---
title: SaaS 定价草案 v3
summary: 三档订阅 + 用量计费的组合方案，含竞品对照。
---

# SaaS 定价草案 v3

## 结论

- 保留三档订阅（Starter / Growth / Enterprise），**不再**按坐席数计价。
- 超出配额的 API 调用按用量计费，单价 ¥0.012 / 千次。
- Enterprise 档取消公开价，走报价单。

## 竞品对照

| 产品 | 入门价 | 计价单位 | 免费额度 |
| --- | --- | --- | --- |
| A 家 | $19 / 月 | 坐席 | 14 天试用 |
| B 家 | $49 / 月 | 工作区 | 1000 次 / 月 |
| 我们（现价） | ¥99 / 月 | 坐席 | 无 |
| 我们（草案） | ¥149 / 月 | 工作区 | 2000 次 / 月 |

## 待办

1. 与财务确认毛利率下限（当前假设 68%）。
2. 老客户迁移方案：按工作区折算，首年不涨价。
3. 官网价格页文案改写。
`

const MD_AGENT_NOTE = `---
title: 渠道复盘要点（agent 整理）
---

# 2026-Q3 渠道复盘要点

来源：\`mail-attachments/2026-08/2026-Q3 渠道复盘.docx\`（解析版）

## 三个结论

1. 华东区新签同比 +18%，但客单价下滑 11%，净收入基本持平。
2. 线上渠道获客成本连续两季度上升，主要来自投放竞价。
3. 代理商渠道的回款周期从 45 天拉到 62 天，影响现金流。

## 需要人确认的地方

- 「客单价下滑」是否含一次性折扣？原表里没有拆分口径。
- 代理商回款口径疑似换过（Q2 用开票日、Q3 用签收日）。
`

const PDF_TEXT = `第 1 页
────────────────
Omada Networks · 服务协议（2026 版）

甲方：Omada Networks（上海）有限公司
乙方：__________________________

第一条 服务内容
乙方向甲方提供云端邮件同步与智能处理服务，具体范围见附件一。

第 2 页
────────────────
第二条 服务期限
自 2026 年 9 月 1 日起至 2027 年 8 月 31 日止，共 12 个月。
期满前 30 日任一方未书面提出终止的，本协议自动续期 12 个月。

第三条 服务费用
年度服务费为人民币 240,000 元（含税），分两期支付。

第 3 页
────────────────
第四条 数据与保密
乙方对甲方数据负保密义务，未经书面同意不得向第三方披露。
本协议终止后 30 日内，乙方应删除全部甲方数据并出具书面确认。
`

const OFFICE_MD = `# 2026-Q3 渠道复盘

## 一、总览

| 区域 | 新签（万元） | 同比 | 客单价（元） | 同比 |
| --- | --- | --- | --- | --- |
| 华东 | 1,284 | +18% | 42,800 | -11% |
| 华南 | 906 | +4% | 51,200 | +2% |
| 华北 | 742 | -6% | 47,500 | -3% |
| 西南 | 318 | +31% | 33,900 | -18% |

## 二、渠道结构

线上直销 41%，代理商 37%，行业伙伴 22%。代理商占比较上季度 +5pp。

## 三、问题

1. **获客成本**：线上渠道 CAC 从 6,100 元升到 7,400 元。
2. **回款**：代理商平均回款周期 62 天（上季 45 天）。
3. **续约**：Starter 档续约率 61%，低于目标 70%。
`

const CSV_MD = `| 发票号 | 客户 | 金额 | 开票日 | 状态 |
| --- | --- | --- | --- | --- |
| INV-20260814 | 华东科技 | 128,000 | 2026-08-14 | 已开票 |
| INV-20260815 | 南方物流 | 96,500 | 2026-08-15 | 已开票 |
| INV-20260821 | 北方能源 | 240,000 | 2026-08-21 | 待回款 |
| INV-20260902 | 西部通信 | 58,300 | 2026-09-02 | 草稿 |
`

const HTML_DOC = `<h1>MailAgent 发布说明 · v2.36.0</h1>
<p>本次更新集中在通知深链与反馈卡执行态。</p>
<h2>修复</h2>
<ul>
  <li>agent 执行通知直达团队页该成员的记录档。</li>
  <li>免卡执行的审批卡显示执行中，主 agent 反馈的诊断包跳过 quick_check。</li>
  <li>agent run 通知标题用成员真名 + 触发源中文。</li>
</ul>
<p><a href="https://mailagent.chenge.ink">查看完整说明</a></p>
`

const OCR_TEXT = `会议白板（OCR）

L4 个人 agent 节点
  ├ matters   事项是第一类对象
  ├ calendar  日程三源
  └ library   ← 本次

结论：先做基座，检索留 P3
下次：09-09 复盘
`

// ── 文件 ──────────────────────────────────────────────────────────────
export const FILES: LibFile[] = [
  // ── 投影区（只读，来源 = 邮件主题 + 发件人） ──
  {
    id: 101,
    rel_path: 'mail-attachments/2026-08/2026-Q3 渠道复盘.docx',
    parent_path: 'mail-attachments/2026-08',
    filename: '2026-Q3 渠道复盘.docx',
    kind: 'office',
    size_bytes: 2_418_960,
    mtime: '2026-08-14T09:32:00+08:00',
    content_hash: 'a91f0c22',
    source: 'mail',
    source_ref: 'Re: Q3 渠道数据对齐 · 王磊 <lei.wang@partner.example.com>',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    extractor: 'anydoc',
    body: OFFICE_MD,
    matters: ['Q3 渠道复盘会']
  },
  {
    id: 102,
    rel_path: 'mail-attachments/2026-08/invoice_INV-20260814.pdf',
    parent_path: 'mail-attachments/2026-08',
    filename: 'invoice_INV-20260814.pdf',
    kind: 'pdf',
    size_bytes: 184_320,
    mtime: '2026-08-14T18:05:00+08:00',
    content_hash: 'c07b31de',
    source: 'mail',
    source_ref: '8 月发票 · 财务共享 <ap@omadanetworks.com>',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    extractor: 'pypdf',
    body: PDF_TEXT
  },
  {
    id: 103,
    rel_path: 'mail-attachments/2026-08/whiteboard-0812.jpg',
    parent_path: 'mail-attachments/2026-08',
    filename: 'whiteboard-0812.jpg',
    kind: 'image',
    size_bytes: 3_640_112,
    mtime: '2026-08-12T21:14:00+08:00',
    content_hash: '4e2a90bb',
    source: 'mail',
    source_ref: '今天白板拍照 · 陈可 <ke.chen@omadanetworks.com>',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    extractor: 'vision_ocr',
    body: OCR_TEXT
  },
  {
    id: 104,
    rel_path: 'mail-attachments/2026-08/kickoff-recording.mp4',
    parent_path: 'mail-attachments/2026-08',
    filename: 'kickoff-recording.mp4',
    kind: 'video',
    size_bytes: 412_936_704,
    mtime: '2026-08-05T14:00:00+08:00',
    content_hash: 'ff10a7c1',
    source: 'mail',
    source_ref: 'Kickoff 录屏 · Teams <noreply@microsoft.com>',
    created_by: 'user',
    status: 'present',
    text_status: 'unsupported'
  },
  {
    id: 105,
    rel_path: 'mail-attachments/2026-08/pricing-comparison.numbers',
    parent_path: 'mail-attachments/2026-08',
    filename: 'pricing-comparison.numbers',
    kind: 'other',
    size_bytes: 742_400,
    mtime: '2026-08-19T11:20:00+08:00',
    content_hash: '2b8ce004',
    source: 'mail',
    source_ref: '竞品价格整理 · 李思远 <siyuan.li@omadanetworks.com>',
    created_by: 'user',
    status: 'present',
    text_status: 'unsupported'
  },
  {
    id: 106,
    rel_path: 'mail-attachments/2026-08/legacy-spec.doc',
    parent_path: 'mail-attachments/2026-08',
    filename: 'legacy-spec.doc',
    kind: 'office',
    size_bytes: 1_048_576,
    mtime: '2026-08-02T08:41:00+08:00',
    content_hash: '90bb12ff',
    source: 'mail',
    source_ref: '老版本规格书 · 供应商 <spec@vendor.example.cn>',
    created_by: 'user',
    status: 'present',
    text_status: 'failed'
  },

  // ── 对话附件（发送即入库） ──
  {
    id: 201,
    rel_path: 'chat-attachments/2026-09/SaaS pricing draft v3.md',
    parent_path: 'chat-attachments/2026-09',
    filename: 'SaaS pricing draft v3.md',
    title: 'SaaS 定价草案 v3',
    kind: 'markdown',
    size_bytes: 4_218,
    mtime: '2026-09-01T22:10:00+08:00',
    content_hash: 'd41d8cd9',
    source: 'chat',
    source_ref: '和主 agent 聊定价（会话 #482）',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    body: MD_PRICING,
    matters: ['定价改版']
  },
  {
    id: 202,
    rel_path: 'chat-attachments/2026-09/screenshot-2026-09-01.png',
    parent_path: 'chat-attachments/2026-09',
    filename: 'screenshot-2026-09-01.png',
    kind: 'image',
    size_bytes: 892_144,
    mtime: '2026-09-01T22:12:00+08:00',
    content_hash: '77c0ab31',
    source: 'chat',
    source_ref: '和主 agent 聊定价（会话 #482）',
    created_by: 'user',
    status: 'present',
    text_status: null
  },
  {
    id: 203,
    rel_path: 'chat-attachments/2026-09/竞品调研.xlsx',
    parent_path: 'chat-attachments/2026-09',
    filename: '竞品调研.xlsx',
    kind: 'office',
    size_bytes: 158_720,
    mtime: '2026-09-02T09:05:00+08:00',
    content_hash: 'be71a005',
    source: 'chat',
    source_ref: '竞品对照（会话 #488）',
    created_by: 'user',
    status: 'present',
    text_status: 'pending'
  },

  // ── Agents 文档 ──
  {
    id: 301,
    rel_path: 'agent-docs/index.md',
    parent_path: 'agent-docs',
    filename: 'index.md',
    title: 'Agents 文档索引',
    kind: 'markdown',
    size_bytes: 1_920,
    mtime: '2026-09-02T07:30:00+08:00',
    content_hash: '11aa22bb',
    source: 'agent',
    source_ref: '主 agent',
    created_by: 'main',
    status: 'present',
    text_status: 'extracted',
    body: `# Agents 文档索引\n\n- \`notes/\` 会议与邮件的整理稿\n- \`sources/\` 从别处摘来的原始材料\n- \`reports/\` 定期产出\n- \`meeting-prep/\` 会前准备（P4）\n\n> 这份索引由主 agent 自己维护，暂不做定时重建。\n`
  },
  {
    id: 302,
    rel_path: 'agent-docs/notes/2026-Q3 渠道复盘要点.md',
    parent_path: 'agent-docs/notes',
    filename: '2026-Q3 渠道复盘要点.md',
    title: '渠道复盘要点（agent 整理）',
    kind: 'markdown',
    size_bytes: 2_640,
    mtime: '2026-09-02T08:02:00+08:00',
    content_hash: '5f3c81ea',
    source: 'agent',
    source_ref: '跟进 Agent',
    created_by: 'followup-agent',
    status: 'present',
    text_status: 'extracted',
    body: MD_AGENT_NOTE,
    matters: ['Q3 渠道复盘会', '定价改版']
  },
  {
    id: 303,
    rel_path: 'agent-docs/notes/log.md',
    parent_path: 'agent-docs/notes',
    filename: 'log.md',
    kind: 'markdown',
    size_bytes: 8_912,
    mtime: '2026-09-02T08:02:00+08:00',
    content_hash: '77de01c9',
    source: 'agent',
    source_ref: '跟进 Agent',
    created_by: 'followup-agent',
    status: 'present',
    text_status: 'extracted',
    body: `# 写入日志\n\n- 2026-09-02 08:02 追加「渠道复盘要点」三条结论（followup-agent）\n- 2026-09-01 22:40 新建 sources/竞品价格.md（main）\n- 2026-08-30 19:12 覆写 reports/周报-0830.md（report-agent）\n`
  },
  {
    id: 304,
    rel_path: 'agent-docs/sources/竞品价格.md',
    parent_path: 'agent-docs/sources',
    filename: '竞品价格.md',
    kind: 'markdown',
    size_bytes: 3_180,
    mtime: '2026-09-01T22:40:00+08:00',
    content_hash: '0ab9c711',
    source: 'agent',
    source_ref: '主 agent',
    created_by: 'main',
    status: 'present',
    text_status: 'extracted',
    body: `# 竞品价格（网页摘录）\n\n> 来源：三家官网价格页，2026-09-01 抓取。价格随时会变，用前先核。\n\n- A 家：$19 / 坐席 / 月，年付 8 折\n- B 家：$49 / 工作区 / 月，含 1000 次 API\n- C 家：报价制，公开页无价格\n`
  },
  {
    id: 305,
    rel_path: 'agent-docs/reports/周报-0830.md',
    parent_path: 'agent-docs/reports',
    filename: '周报-0830.md',
    title: '第 35 周周报',
    kind: 'markdown',
    size_bytes: 5_402,
    mtime: '2026-08-30T19:12:00+08:00',
    content_hash: 'cc2201ab',
    source: 'agent',
    source_ref: '报告 Agent',
    created_by: 'report-agent',
    status: 'present',
    text_status: 'extracted',
    body: `# 第 35 周周报\n\n## 本周\n\n- 通知中心 M3 上线，徽标口径收编完成。\n- 群聊实验批装机，等 owner dogfood。\n\n## 下周\n\n- 资料库设计定稿，出 UI mockup。\n`
  },

  // ── 我的文档 ──
  {
    id: 401,
    rel_path: 'my-docs/README.md',
    parent_path: 'my-docs',
    filename: 'README.md',
    title: '我的文档',
    kind: 'markdown',
    size_bytes: 640,
    mtime: '2026-08-21T10:00:00+08:00',
    content_hash: 'aa01bb02',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    body: `# 我的文档\n\n这个文件夹 agent 默认只读。要让 agent 写，把文件放到 \`agent-docs/\`。\n`
  },
  {
    id: 402,
    rel_path: 'my-docs/合同/服务协议-2026.pdf',
    parent_path: 'my-docs/合同',
    filename: '服务协议-2026.pdf',
    kind: 'pdf',
    size_bytes: 486_400,
    mtime: '2026-08-25T16:30:00+08:00',
    content_hash: 'ee11dd22',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    extractor: 'pypdf',
    body: PDF_TEXT,
    matters: ['2026 续约']
  },
  {
    id: 403,
    rel_path: 'my-docs/产品/定价/SaaS pricing draft v3.md',
    parent_path: 'my-docs/产品/定价',
    filename: 'SaaS pricing draft v3.md',
    title: 'SaaS 定价草案 v3',
    kind: 'markdown',
    size_bytes: 4_218,
    mtime: '2026-09-02T10:22:00+08:00',
    content_hash: 'd41d8cd9',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    body: MD_PRICING,
    matters: ['定价改版']
  },
  {
    id: 404,
    rel_path: 'my-docs/产品/发布说明-v2.36.0.html',
    parent_path: 'my-docs/产品',
    filename: '发布说明-v2.36.0.html',
    kind: 'html',
    size_bytes: 12_408,
    mtime: '2026-08-31T20:10:00+08:00',
    content_hash: '3fa0d9b1',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    body: HTML_DOC
  },
  {
    id: 405,
    rel_path: 'my-docs/产品/invoices-2026-08.csv',
    parent_path: 'my-docs/产品',
    filename: 'invoices-2026-08.csv',
    kind: 'text',
    size_bytes: 3_072,
    mtime: '2026-08-31T23:59:00+08:00',
    content_hash: '5d0a11f3',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    extractor: 'plaintext',
    body: CSV_MD
  },
  {
    id: 406,
    rel_path: 'my-docs/产品/旧版路线图.pptx',
    parent_path: 'my-docs/产品',
    filename: '旧版路线图.pptx',
    kind: 'office',
    size_bytes: 8_912_896,
    mtime: '2026-06-11T13:20:00+08:00',
    content_hash: 'ab0c7712',
    source: 'user',
    created_by: 'user',
    status: 'missing',
    text_status: 'extracted',
    extractor: 'anydoc',
    body: '# 旧版路线图\n\n（解析版仍在索引里，但原文件已不在磁盘上。）\n'
  },
  {
    id: 407,
    rel_path: 'my-docs/产品/定价/服务协议-2026（解析版）.md',
    parent_path: 'my-docs/产品/定价',
    filename: '服务协议-2026（解析版）.md',
    title: '服务协议 2026（解析版）',
    kind: 'markdown',
    size_bytes: 6_120,
    mtime: '2026-08-25T16:35:00+08:00',
    content_hash: '9c31ff20',
    source: 'derived',
    source_ref: '服务协议-2026.pdf',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    body: PDF_TEXT
  },

  // ── 挂载根 ──
  {
    id: 501,
    rel_path: '@工作区/2026-Q3/渠道数据.xlsx',
    parent_path: '@工作区/2026-Q3',
    filename: '渠道数据.xlsx',
    kind: 'office',
    size_bytes: 1_284_096,
    mtime: '2026-08-29T17:45:00+08:00',
    content_hash: '77aa10cd',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    extractor: 'anydoc',
    body: OFFICE_MD
  },
  {
    id: 502,
    rel_path: '@工作区/2026-Q3/复盘纪要.md',
    parent_path: '@工作区/2026-Q3',
    filename: '复盘纪要.md',
    title: 'Q3 复盘纪要',
    kind: 'markdown',
    size_bytes: 7_204,
    mtime: '2026-09-02T11:02:00+08:00',
    content_hash: 'b120ce07',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    body: MD_AGENT_NOTE
  },
  {
    id: 503,
    rel_path: '@工作区/招投标/标书正文.docx',
    parent_path: '@工作区/招投标',
    filename: '标书正文.docx',
    kind: 'office',
    size_bytes: 5_242_880,
    mtime: '2026-08-30T09:15:00+08:00',
    content_hash: '11fe90aa',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'pending'
  },
  {
    id: 504,
    rel_path: '@Design 素材/brand/logo-primary.png',
    parent_path: '@Design 素材/brand',
    filename: 'logo-primary.png',
    kind: 'image',
    size_bytes: 240_128,
    mtime: '2026-05-18T10:00:00+08:00',
    content_hash: 'de01ba99',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: null
  },
  {
    id: 505,
    rel_path: '@Design 素材/brand/品牌规范.pdf',
    parent_path: '@Design 素材/brand',
    filename: '品牌规范.pdf',
    kind: 'pdf',
    size_bytes: 24_117_248,
    mtime: '2026-05-18T10:04:00+08:00',
    content_hash: 'ac7712de',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    extractor: 'pdf_ocr',
    body: PDF_TEXT,
    truncated: true
  },
  {
    id: 506,
    rel_path: '@工作区/2026-Q3/存档.zip.icloud',
    parent_path: '@工作区/2026-Q3',
    filename: '存档.zip',
    kind: 'placeholder',
    size_bytes: null,
    mtime: '2026-07-20T12:00:00+08:00',
    content_hash: '',
    source: 'user',
    created_by: 'user',
    status: 'present',
    text_status: 'unsupported'
  },

  // ── 废纸篓 ──
  {
    id: 601,
    rel_path: '.trash/agent-docs/notes/废弃草稿.md',
    parent_path: '.trash',
    filename: '废弃草稿.md',
    kind: 'markdown',
    size_bytes: 1_204,
    mtime: '2026-08-28T14:20:00+08:00',
    content_hash: 'ff00ab12',
    source: 'agent',
    source_ref: '主 agent',
    created_by: 'main',
    status: 'trashed',
    text_status: 'extracted',
    trashDaysLeft: 25,
    body: '# 废弃草稿\n\n这份被 agent 建了又删。删除是软删，30 天内可以恢复。\n'
  },
  {
    id: 602,
    rel_path: '.trash/my-docs/旧价格表.csv',
    parent_path: '.trash',
    filename: '旧价格表.csv',
    kind: 'text',
    size_bytes: 2_048,
    mtime: '2026-08-10T09:00:00+08:00',
    content_hash: 'cd77ba01',
    source: 'user',
    created_by: 'user',
    status: 'trashed',
    text_status: 'extracted',
    trashDaysLeft: 12,
    body: CSV_MD
  },
  {
    id: 603,
    rel_path: '.trash/chat-attachments/临时截图.png',
    parent_path: '.trash',
    filename: '临时截图.png',
    kind: 'image',
    size_bytes: 118_784,
    mtime: '2026-08-06T18:33:00+08:00',
    content_hash: '01ffaa22',
    source: 'chat',
    source_ref: '会话 #401',
    created_by: 'user',
    status: 'trashed',
    text_status: null,
    trashDaysLeft: 3
  }
]

export function filesIn(path: string): LibFile[] {
  return FILES.filter((f) => f.parent_path === path)
}

export function fileById(id: number): LibFile | undefined {
  return FILES.find((f) => f.id === id)
}

export function foldersIn(path: string): LibFolder[] {
  return FOLDERS.filter((f) => {
    if (!f.path.startsWith(`${path}/`)) return false
    return f.path.slice(path.length + 1).indexOf('/') < 0
  })
}

// ── 历史（design §4） ─────────────────────────────────────────────────
export const HISTORY: LibHistoryRow[] = [
  {
    id: 5,
    changed_by: 'followup-agent',
    change_note: '补三条结论 + 两处待确认',
    created_at: '2026-09-02T08:02:00+08:00',
    size_bytes: 2_640,
    delta: 780,
    snapshot: MD_AGENT_NOTE
  },
  {
    id: 4,
    changed_by: 'user',
    change_note: '删掉重复的一段',
    created_at: '2026-09-01T21:15:00+08:00',
    size_bytes: 1_860,
    delta: -410,
    snapshot: MD_AGENT_NOTE.replace('## 需要人确认的地方', '## 待确认')
  },
  {
    id: 3,
    changed_by: 'external',
    change_note: null,
    created_at: '2026-09-01T12:40:00+08:00',
    size_bytes: 2_270,
    delta: 62,
    snapshot: `${MD_AGENT_NOTE}\n（这一版是在应用之外改的，打开时对账补记。）\n`
  },
  {
    id: 2,
    changed_by: 'main',
    change_note: '从解析版摘要生成初稿',
    created_at: '2026-08-31T19:02:00+08:00',
    size_bytes: 2_208,
    delta: 2_208,
    snapshot: '# 2026-Q3 渠道复盘要点\n\n（初稿）\n'
  },
  {
    id: 1,
    changed_by: 'main',
    change_note: '新建',
    created_at: '2026-08-31T18:58:00+08:00',
    size_bytes: 0,
    delta: 0,
    snapshot: ''
  }
]

// ── 搜索结果（design §9.1，带 match 标记） ────────────────────────────
export interface LibHit {
  fileId: number
  snippet: string
  match: 'fts' | 'vec' | 'both'
}

export const HITS: LibHit[] = [
  {
    fileId: 403,
    snippet: '超出配额的 API 调用按<mark>用量计费</mark>，单价 ¥0.012 / 千次。',
    match: 'both'
  },
  {
    fileId: 101,
    snippet: '线上渠道 CAC 从 6,100 元升到 7,400 元；<mark>客单价</mark>同比 -11%。',
    match: 'fts'
  },
  {
    fileId: 302,
    snippet: '「客单价下滑」是否含一次性折扣？原表里没有拆分口径。',
    match: 'vec'
  },
  {
    fileId: 304,
    snippet: 'B 家：$49 / 工作区 / 月，含 1000 次 <mark>API</mark>',
    match: 'fts'
  },
  {
    fileId: 501,
    snippet: '华东 1,284 万元，同比 +18%；<mark>客单价</mark> 42,800 元。',
    match: 'both'
  },
  {
    fileId: 402,
    snippet: '年度服务费为人民币 240,000 元（含税），分两期支付。',
    match: 'vec'
  }
]

// ── 通讯用：事项 / 通知 / 会话的假数据 ───────────────────────────────
export const MATTERS = [
  { id: 'm1', title: 'Q3 渠道复盘会' },
  { id: 'm2', title: '定价改版' },
  { id: 'm3', title: '2026 续约' }
]

export const RECENT_FILE_IDS = [302, 403, 101, 502, 202, 405]
