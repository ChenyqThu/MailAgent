# Frontend Design Handoff — 给 claude design 的设计任务

> **目的**: 一份"打包好的设计任务包"，给 `frontend-design` skill (claude design)
> 做 V1 视觉 / 组件 mockup 用。把零散的 architecture / feature spec 收口成单一
> 入口，附完整 prompt 可直接 copy。
>
> **状态**: 2026-05-16 起草。设计完了 spec 这边再 review。
>
> **设计交付物期望**: HTML/React + Tailwind + shadcn/ui 的可跑 mockup
> （3-5 个主页面），优先 dark mode，本地可 preview。

---

## 1. 项目一句话

**MailAgent** 是 macOS 邮件 → Notion 实时同步系统：邮件用 SQLite 做 SSoT，本地服务
跑 LLM 分类 + 飞书通知 + Notion 双向 sync。前端是 **Electron desktop app**，给用户
本机看邮件 / 搜索 / 做高频运维操作（重传 / AI 重跑 / 看 dead-letter）。

**不是**: 写邮件客户端（写邮件走 Mail.app）/ 远程 web 版 / 多用户工具。

---

## 2. 文档清单

按"看这一份就够干这件事"的颗粒度整理：

| # | 文档 | 一句话作用 | 给 designer 的关键章节 |
|---|---|---|---|
| 1 | [`frontend-design-handoff.md`](./frontend-design-handoff.md) | **本文** — designer 入口 + 完整 prompt | 全文 |
| 2 | [`frontend-v1-feature-spec.md`](./frontend-v1-feature-spec.md) | 要做哪些页面 / 功能 / 信息架构 / 动效 | §1 MVP, §8 IA, §9 动效场景 |
| 3 | [`frontend-v1-implementation-plan.md`](./frontend-v1-implementation-plan.md) | 技术栈 + 7 Sprint 拆分 | §2 路由结构 (设计要按这些 route 出 page) |
| 4 | [`frontend-v1-tech-tradeoffs.md`](./frontend-v1-tech-tradeoffs.md) | 12 选型 trade-off | §5 (Tailwind + shadcn) §6 (邮件 HTML 安全) |
| 5 | [`frontend-integration-spec.md`](./frontend-integration-spec.md) | 后端 4 接口面 + 数据契约 | §4 (SQLite 直读) §7 (数据契约) — 看数据形状决定 UI 字段 |
| 6 | [`agent-cli-rfc.md`](./agent-cli-rfc.md) | CLI 完整 spec | §4 命令树 — 看 CLI 能力决定 UI 操作按钮 |
| 7 | [`../CLAUDE.md`](../CLAUDE.md) | 项目总览 (后端架构 / 配置 / Notion DB schema) | 邮件数据库字段 / AI 字段枚举 / Processing Status 语义 |

**第一次读顺序**: 1（本文）→ 2 §1 §8 §9 → 5 §7 → 7 (Notion 数据库结构)

---

## 3. 设计任务范围 (V1 MVP, 3-5 个 mockup)

### 必做 mockup (覆盖 MVP 4 page)

1. **Inbox 列表页** `/` — 三栏布局 (Sidebar | Email List | Detail)
   - 默认状态: 收件箱选中, list 50 封, detail 显示第一封
   - 有 unread badge / flagged / has-attachments icon
   - 顶部有 quick filter bar (Unread / Flagged / Has Attachments / Date Range)

2. **邮件详情 detail pane** — 嵌在 Inbox 右侧
   - Header (Subject h1 / From + To / Date / AI 字段 chips)
   - HTML body iframe (placeholder 一段邮件正文)
   - 附件 list (PDF / 图 / docx → derived PDF)
   - 线程 sidebar (可折叠, 显示父+子邮件)
   - Toolbar (V1): [Resync Notion] [AI Rerun] [Mark Read/Flag] [Open in Notion]

3. **全文搜索页** `/search`
   - 搜索框 (FTS5 语法 hint)
   - 历史搜索 (chips)
   - 结果 list (subject / sender / snippet 高亮 / bm25 score)
   - 空状态 (zero result + 中文搜索 `*` 前缀提示)

4. **设置页** `/settings`
   - API key 输入 (masked, 测试 ping 按钮)
   - DB 路径 + 附件路径 (folder picker)
   - 轮询频率 (5s / 10s / 30s / off)
   - Theme (light / dark / system)
   - About + GitHub link

### 推荐 mockup (V1, 视精力)

5. **看板 admin** `/admin` — health + sync 状态分布 + dead-letter list + v4 rollout
6. **LLM dashboard** `/llm` — 状态分布 + cost 时间线 + cache hit rate + 失败 list

### 关键组件 (在 mockup 里复用)

- **EmailRow** (list item) — 1 行 / hover state / unread 加粗 / 各种 icons
- **AILabel chip** — Action / Priority 用不同颜色 (Critical 红 / Urgent 橙 / Important 黄 / Normal 灰)
- **Toast** (top-right, success / error / info 3 色 + auto-dismiss)
- **CommandPalette** (cmd+k, 模糊搜邮件 / 切 mailbox / 跳设置)
- **Toolbar button** (icon + label, hover scale, busy state 转圈)
- **StatusBadge** (synced 绿 / pending 黄 / failed 红 / dead 灰)
- **ProgressBar + LogTail** (长任务用)

---

## 4. 设计语言关键词

| 维度 | 关键词 |
|---|---|
| 整体感 | 专业 / 严肃 / 工具 (不是 SaaS marketing) |
| 信息密度 | 高 (邮件 1 行容纳 subject+sender+date+icons, 不是 card) |
| 本机感 | 与 macOS 原生协调 (vibrancy / blur / inset shadow 可用但克制) |
| 中文优先 | 字号 14px+ 中文不糊, 字重对比清晰 |
| 模式 | **Dark mode 优先**, light mode 也支持 |
| 品牌色 | accent 留给 designer 定 (建议系统蓝 #007AFF / Notion 灰 #2C2C2C 系基础) |
| 字体 | macOS 系统字体 (-apple-system / SF Pro), 中文 PingFang SC |

---

## 5. 参考 / 不要

### 学这些
- **Mimestream** (macOS Gmail client) — 三栏布局 / 信息密度 / 本机感
- **Spark / Superhuman** — 键盘流 / quick action
- **Linear** — toolbar / cmd+k / 动效克制
- **Notion** — sidebar / breadcrumb
- **VS Code** — 命令面板 / panel resize / 状态栏

### 不要
- ❌ 通用 AI SaaS 风 (大 hero / 紫蓝渐变 / 三栏 features card)
- ❌ Material UI 风 (FAB / ripple / 厚 shadow)
- ❌ 圆 padding 28px 卡片堆叠 / 大量 emoji badge
- ❌ Confetti / particles / 弹簧 bouncy 动画
- ❌ 韩式偏小 11-12px 正文字号 (中文糊)
- ❌ Tailwind 默认蓝色 #3B82F6 (太 generic, 必须替换)
- ❌ 全屏 splash screen / loading 转圈占满
- ❌ 模态对话框过度 backdrop blur

---

## 6. Designer Prompt（直接 copy 到新 session）

```
我用 frontend-design skill (claude design) 给一个 macOS Electron 邮件 app 出
V1 视觉 mockup。技术栈定: React + TypeScript + Tailwind + shadcn/ui + Lucide
icons + better-sqlite3 (Electron main) + execa (CLI fork)。

【项目背景】
MailAgent — macOS 邮件 → Notion 实时同步系统。邮件用 SQLite 做 SSoT (本地
~/Documents/MailAgent/data/sync_store.db), 本地 mail-sync 服务跑 LLM 分类 +
飞书通知 + Notion 双向 sync。前端 Electron app 给用户本机看邮件 / 搜索 /
高频运维操作 (重传 / AI 重跑 / 看 dead-letter)。

【完整 spec】
读这几份文档 (按顺序):
1. /Users/chenyuanquan/Documents/MailAgent/docs/frontend-design-handoff.md (设计入口 + 任务清单)
2. /Users/chenyuanquan/Documents/MailAgent/docs/frontend-v1-feature-spec.md (功能 + 信息架构 §8 + 动效场景 §9)
3. /Users/chenyuanquan/Documents/MailAgent/docs/frontend-integration-spec.md (数据契约 §7 — 决定 UI 字段)
4. /Users/chenyuanquan/Documents/MailAgent/CLAUDE.md (Notion DB schema / AI 字段枚举)

【要交付的 mockup】
MVP (必做, 3-5 个):
1. Inbox 列表页 (三栏: Sidebar | EmailList | DetailPane), 默认看着像有数据的状态
2. 邮件详情 detail pane (HTML body + 附件 + AI 字段 chips + Toolbar)
3. 全文搜索页 (搜索框 + 历史 + 结果 list with snippet 高亮)
4. 设置页 (API key / DB 路径 / 轮询频率 / theme)

可选 (V1, 视精力):
5. /admin 看板 (health + sync 状态分布 + dead-letter)
6. /llm dashboard (cost 时间线 + cache hit rate)

【关键组件 (复用 across mockups)】
- EmailRow (list item, hover + unread + icons)
- AILabel chip (Action / Priority 不同颜色)
- Toast (top-right, 3 色)
- CommandPalette (cmd+k)
- Toolbar button (icon + label + busy state)
- StatusBadge (synced/pending/failed/dead 4 色)
- ProgressBar + LogTail (长任务)

【设计语言】
- 专业 / 严肃 / 工具 (像 Mimestream / Linear / Notion, 不像通用 SaaS)
- 信息密度高 (邮件 list 1 行容纳 subject+sender+date+icons, 不是 card)
- 本机感 (与 macOS 原生协调)
- 中文优先 (字号 14px+ 不糊)
- Dark mode 优先, light mode 也支持
- 字体: -apple-system / SF Pro / PingFang SC
- 品牌色 accent 你定 (避免 Tailwind 默认蓝 #3B82F6)

【不要】
- ❌ 通用 AI SaaS 风 (大 hero / 紫蓝渐变 / 三栏 features card)
- ❌ Material UI 风 (FAB / ripple / 厚 shadow)
- ❌ 圆 28px 卡片堆叠 / 大量 emoji badge
- ❌ Confetti / 弹簧 bouncy 动画
- ❌ 韩式 11-12px 中文字号 (糊)
- ❌ Tailwind 默认蓝色
- ❌ 全屏 splash / loading 转圈占满

【参考 (学这些 app)】
- Mimestream / Spark / Superhuman / Linear / Notion / VS Code

【输出形式】
- HTML/React + Tailwind + shadcn/ui, 单文件可 preview (放 mockups/ 子目录)
- 每页一个文件 (mockup-inbox.html / mockup-detail.html / mockup-search.html / mockup-settings.html)
- 用合理的 placeholder 数据 (邮件 subject / sender 用中英文混合, 反映真实场景)
- 不需要交互逻辑, 只要静态 mockup + hover state
- 暗色模式默认 (dark:* 类必须先到位)
- 配 README.md 说明每页设计决策 (字号系统 / 颜色 / spacing / 组件层级)

【先做什么】
先读完上面 4 份 spec, 然后只出 mockup-inbox.html (最关键), 我 review 后再继续
其他页面。
```

---

## 7. Designer 完工后我这边怎么用

- mockup 文件 → 放 `mockups/` 子目录 (新建)
- review 视觉决策 → 调 / 重设计
- 视觉定稿后 → Sprint 0 工程脚手架时直接抽取 Tailwind class + shadcn 组件代码
- 设计 token (颜色 / 字号 / spacing / shadow) 沉淀到 `tailwind.config.ts` (V1 plan §1.1)

---

## 8. Designer 可能的反问 / 我的预答

| 反问 | 我的答案 |
|---|---|
| 邮件 list 默认排序? | date desc, 后续 sort 可改 (V1 §1.1) |
| 邮件 row 上 unread / flagged / attachment 几个 icon 同时显示如何排列? | 你定; 建议右侧 cluster, 不抢 subject 视觉 |
| AI Action chip 用什么颜色映射? | Critical 红 / Urgent 橙 / Important 黄 / Normal 灰 / Low 浅灰. (CLAUDE.md "AI Priority" select 5 个值) |
| Sidebar 折叠后保留什么? | icon + count badge, hover 弹 tooltip |
| Toolbar 按钮位置 (顶部 vs 右侧 vs 命令面板) | 推荐顶部 sticky toolbar; cmd+k 是命令面板补充. (feature-spec §2.1) |
| 详情页是否要 "open in Notion" / "open original eml" 按钮? | 是, toolbar 末尾 secondary action |
| 暗色模式色板 (背景 / 文字 / accent) 给具体值还是你选? | 你选; 参考 Linear 暗色 / VS Code dark+ 风格 |
| 中文字体 PingFang SC vs Noto Sans SC? | PingFang SC (macOS 系统字体, 更原生) |
| 动效 timing / easing 用什么? | 默认 ease-out 150-300ms; framer-motion 在 V1 不强求 (Tailwind transition 够用) |
| Empty state (空收件箱 / 零结果) 怎么画? | 中性插画 / icon + 一句话提示; 不要"功能介绍" 营销文案 |

---

> 本 handoff 是 PR-7 ship 同 batch 起草 (commit 之后). 设计完了 spec 这边再 review,
> 视觉定稿后进入 Sprint 0 工程脚手架。
