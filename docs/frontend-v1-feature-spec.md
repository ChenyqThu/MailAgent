# Frontend V1 Feature Spec

> **目的**: 把 V1 Electron 前端的功能模块按优先级分桶（MVP / V1 / V2），每个功能列
> 数据需求 + 用户故事 + 风险，方便 review 决定取舍。
>
> **状态**: 设计稿（2026-05-16）— pending user review。
>
> **作者**: 基于 [`frontend-integration-spec.md`](./frontend-integration-spec.md) +
> [`frontend-v1-implementation-plan.md`](./frontend-v1-implementation-plan.md)
> + 现有后端能力（CLI 10 group / 45+ schema / FastAPI 8 event handler /
> SQLite 7 table）梳理。

---

## 0. 分桶策略

| 桶 | 标准 | 工作量预算 |
|---|---|---|
| **MVP** | 没它就不能称"邮件 app"。Read-only + 基础导航 | 3-4 天 |
| **V1** | 让 mail-sync 主流程的"高频操作"在前端能做（不必每次去 Notion / 命令行） | 5-9 天 |
| **V2** | Nice-to-have，可独立做 PR；不阻塞 V1 ship | 后续视需求 |
| **Out** | V1 范围外，不在本 spec 讨论 | - |

---

## 1. MVP（必须）— 3-4 天

### 1.1 邮件列表 `/` + `/mailbox/:name`

**用户故事**: 我想看到所有同步过的邮件，按时间倒序，可按邮箱筛选。

**功能要点**:
- 显示字段: subject / sender_name / mailbox badge / date / unread/flagged 图标 / 是否有附件 / AI Action 标签
- 默认 50 条 / 页（虚拟滚动 `react-window`，因可能 6000+ 封）
- Filter: mailbox / status (synced/pending/failed) / is_read / is_flagged / has_attachments / date range
- Sort: date_received desc 默认；可改 date asc / unread first
- Search box (跳 `/search` 而非内联)

**数据需求**:
- `email_metadata` 直读（已支持，~5ms 命中 6000+ 行）
- `last_max_internal_id` 增量轮询 + new badge

**风险**:
- 6000+ 邮件列表卡顿 → 虚拟滚动 + LIMIT/OFFSET
- 中文搜索 token 化 → 走 `/search` 用 FTS5

**对应 V1 plan Sprint**: Sprint 2

### 1.2 邮件详情 `/email/:id`

**用户故事**: 我想点开一封邮件看正文、附件、AI 字段，能知道在 Notion 哪个页面。

**功能要点**:
- HTML render: sandboxed iframe + DOMPurify + 阻止外链直接跳出（点击拦截 → 提示）
- Markdown render: react-markdown (备选 view)
- 内联图片: `data/attachments/{internal_id}/cid_*` 本地路径替换 `<img src="cid:xxx">`
- 附件列表: filename / size / 是否有 derived (PDF/CSV)
- AI 字段: 11 个 select / multi-select 可见 (Action / Priority / SenderPriority / ...)
- Header: from / to / cc / date / message_id / thread_id / notion_page_id (link)
- 操作按钮 (V1 才做): "重传 Notion" / "AI 重跑" / "更新旗标" — MVP 阶段灰显但可见

**数据需求**:
- `email_metadata` + `email_body` + `email_attachment` 直读
- 附件二进制走 file:// 协议或 IPC handler

**风险**:
- 邮件 HTML 含 phishing 链接 / 恶意 JS → sandboxed iframe + sanitize 必须做
- 附件路径含中文 / emoji → URL 转义

**对应 V1 plan Sprint**: Sprint 2

### 1.3 全文搜索 `/search`

**用户故事**: 我想搜邮件正文（"redis timeout" / "项目 xxx"），看哪封邮件提到。

**功能要点**:
- FTS5 输入框 + 高级语法 hint（短语 "..." / AND / OR / NOT / *）
- 结果显示: subject / sender / snippet 高亮 (`<mark>`) / bm25 rank / 点击跳详情
- Filter: mailbox / date range / has_attachments
- 中文搜索: 提示用户加 `*` 前缀（如 `产品*` 而非 `产品`）
- 历史搜索: localStorage 存最近 10 条

**数据需求**:
- `email_body_fts` 直读 + bm25 + snippet
- 同 EmailRepository.search_email_bodies 接口

**风险**:
- 中文 unicode61 tokenizer 限制 → UI 显式提示

**对应 V1 plan Sprint**: Sprint 3

### 1.4 设置 `/settings`

**用户故事**: 首次启动时让我配 API key，能改 DB 路径和轮询频率。

**功能要点**:
- API key (写命令用): 输入 → keychain 存 / 测试 ping `mailagent admin health`
- DB 路径: 默认 `~/Documents/MailAgent/data/sync_store.db`，可改
- 附件根目录: 默认 `~/Documents/MailAgent/data/attachments`
- 轮询频率: 5s / 10s / 30s / off（默认 5s）
- Theme: light / dark / system
- About: 版本号 / GitHub link

**数据需求**:
- keytar (macOS Keychain)
- electron-store / file system config.json

**风险**:
- 首次启动如未配 API key, MVP 仍可只读 (read 无 auth)

**对应 V1 plan Sprint**: Sprint 6（脚手架时占位）

---

## 2. V1（高频）— 5-9 天

### 2.1 邮件写操作（重传 / AI 重跑 / 更新旗标）

**用户故事**: 我看到一封邮件 Notion 字段出错，想直接在前端点按钮重传 / 重跑 AI，不用回到命令行。

**功能要点**:
- 详情页右上 toolbar: "重传 Notion" (`mailagent email resync <id>`) / "重跑 AI" (`mailagent llm run <id> --force`) / "更新旗标" (radio: read/flagged → `mailagent notion update-flag`)
- 进度: spinner + log tail (CLI stdout 流式展示)
- 错误: toast + JSON wrapper error 显示
- 鉴权: 从 keychain 取 API key 自动加 `--api-key`

**数据需求**:
- CLI fork via execa
- IPC handler 接 stdout stream

**风险**:
- 长任务 SIGINT 二次确认: 弹 dialog "再点一次彻底退出 (130)，否则只是 graceful abort (7)"
- PM2 mail-sync online 时写命令 exit 9: 显示 "PM2 mail-sync 在跑，pm2 stop 后重试 / --allow-concurrent 强制"

**对应 V1 plan Sprint**: Sprint 4

### 2.2 看板 stats `/admin`

**用户故事**: 我想看后端服务健康 / 同步状态 / 是否有失败 / dead-letter 队列。

**功能要点**:
- Health card: `mailagent admin health` 接 / db_version 显示
- 同步状态分布饼图: pending / synced / failed / fetch_failed / dead_letter / skipped
- Last sync: `email_metadata.updated_at` 最近 24h 折线图
- Dead-letter list: 表格 + retry 按钮（`mailagent admin dead-letter retry`）
- v4 rollout 监控: hit_rate / fallback_count / p99_latency (`v4_rollout_stats` 直读)
- Backfill 进度: `cli_checkpoints` 表显示已 resume 的长任务

**数据需求**:
- `email_metadata` aggregations / `cli_checkpoints` / `v4_rollout_stats` 直读
- CLI 'admin health' / 'dead-letter list / retry'

**风险**: 无

**对应 V1 plan Sprint**: Sprint 5

### 2.3 LLM dashboard `/llm`

**用户故事**: 我想看 LLM 处理成功率 / cost / cache hit rate / 跑慢的邮件。

**功能要点**:
- 状态分布: success / failed / gave_up / pending
- Cost 时间线: 7d / 30d 累计 input/output/cache_read/cache_write tokens + 估算 USD
- Cache hit rate 折线
- Latency p50/p95/p99 折线
- "失败邮件" 表格 + retry-failed 按钮 (`mailagent llm retry-failed`)
- Selftest 按钮 (`mailagent llm selftest`)
- 单封 LLM 重跑：跳详情页 → V1 §2.1 toolbar

**数据需求**:
- `llm_processing` 直读 (status / tokens / latency / cost)
- CLI llm stats / selftest / retry-failed

**风险**: 无

**对应 V1 plan Sprint**: Sprint 5

### 2.4 线程视图 `/thread/:id`

**用户故事**: 我看一封邮件，想看到它所属的整个对话线程（父 + 子 + sibling）。

**功能要点**:
- 详情页右侧 collapsible sidebar: thread tree
- Thread 节点: subject / sender / date / 当前邮件高亮
- 点击节点跳对应 `/email/:id`
- 折叠 / 展开

**数据需求**:
- `email_metadata.thread_id` + `notion_thread_id` 查询
- 已有 EmailRepository (V1 §2.4 可能要补 `get_thread(thread_id) → list`)

**风险**:
- 线程可能很长 (50+ 邮件) → 折叠默认只展开当前 + 父
- Thread head 找不到时显示 "thread head missing" badge

**对应 V1 plan Sprint**: Sprint 3

### 2.5 附件预览

**用户故事**: 我想直接在前端预览 PDF / 图片，不用每次下载到 Downloads。

**功能要点**:
- PDF: react-pdf 内嵌
- Image: img tag
- Office (docx/xlsx): 检测 derived PDF/CSV，无则提示 "跑 `mailagent backfill derivatives --internal-id`"
- 其他: 显示 "未预览，点击下载" → spawn 系统 open

**数据需求**:
- file:// 协议或 IPC handler 返回 ArrayBuffer
- `derived_from` 自指 FK 拉 derived 行

**风险**:
- 附件大 (>50MB) → 提示 "用系统 open 而非内嵌"

**对应 V1 plan Sprint**: Sprint 2 (基础) + Sprint 7 (优化)

### 2.6 日程视图 `/calendar`

**用户故事**: 我想看从邮件邀请同步过来的会议日程，能跳到 Notion 对应页面。

**功能要点**:
- 日 / 周 / 月视图（fullcalendar 或自实现）
- 事件来自 SQLite 还是 Notion? **MVP 简化**: 走 CLI `mailagent calendar expand --dry-run -o json` 拿展开后的 occurrences
- 点击事件跳 Notion 页面 (Notion URL 直接 open)
- 周期会议: `mailagent calendar recurring discover` 列表 + replay 按钮

**数据需求**:
- Notion calendar database 查询 (`/admin/api/stats` 可能要补端点) 或 CLI calendar expand
- SQLite `recurring_series` 表（如果有，否则查 Notion）

**风险**:
- Notion API 调用量大 → cache 1h

**对应 V1 plan Sprint**: Sprint 5 (lite 版)

### 2.7 键盘快捷键

**用户故事**: 我习惯 vim / gmail 键盘流，想快速翻邮件 / 搜索 / 操作。

**功能要点**:
- `j`/`k` 上下邮件
- `Enter` 打开详情
- `cmd+k` 全局搜索
- `cmd+r` 重传当前邮件
- `cmd+,` 设置
- `?` 显示快捷键 help

**数据需求**: 无

**风险**:
- 与 Electron 系统快捷键冲突 → 测试 macOS 系统 cmd 组合

**对应 V1 plan Sprint**: Sprint 7

---

## 3. V2（Nice-to-have）— Post-V1

### 3.1 写邮件草稿 / 回复 in-app

**为什么 V2**: 当前 `create_draft` event 走 Mail.app create reply draft，前端
弄写邮件 UI 重复造轮子且要复用 Mail.app SMTP 设置。

### 3.2 看板 SSE / WS 推送

**为什么 V2**: 轮询足够，真实时需求暂无。

### 3.3 多账户切换

**为什么 V2**: 当前单用户 / 单 Mail.app account；多账户改动大。

### 3.4 Mobile / iPad app

**为什么 V2**: 框架 + 鉴权方案完全不同。

### 3.5 项目周报 / Daily Digest UI

**为什么 V2**: 当前 `project-progress sync` 和 Daily Digests 都在 Notion 里看，UI
化收益不明显。

### 3.6 LLM prompt 编辑 in-app

**为什么 V2**: 当前 `prompts/*.md` 直接 git 改 + mtime 热重载，UI 编辑要做 prompt
版本管理 + diff。

---

## 4. Out of V1 范围（确定不做）

| 项 | 原因 |
|---|---|
| 远程 Web 版（FastAPI 中转）| 用户选 Electron + 单用户，跨机器需求不存在 |
| 多用户 / OAuth | 同上 |
| Push notification (FCM/APNs) | 仅 desktop，电脑通知用 Electron Notification 即可 |
| 反向操作 Mail.app SMTP 直发 | Mail.app 流程已稳定 |
| Notion schema 管理 UI | 数据库 schema 由 Notion 后台管 |
| 飞书机器人配置 UI | 配置走 `.env`，前端不动 |
| Webhook server 远程管理 | 远程 webhook-server 自带 dashboard |

---

## 5. MVP → V1 → V2 升级路径

```
MVP (3-4 天):
├── /              邮件列表
├── /email/:id     详情（read-only）
├── /search        全文搜索
└── /settings      keychain + 配置

V1 (5-9 天 atop MVP):
├── 详情页 toolbar 写操作（重传 / AI 重跑 / 更新旗标）
├── /admin         看板 + dead-letter
├── /llm           LLM dashboard
├── /thread/:id    线程视图
├── /calendar      日程
├── 附件预览
└── 键盘快捷键

V2 (post-V1):
├── 写邮件 in-app
├── SSE/WS 推送
├── 多账户
├── Mobile
└── prompt UI
```

---

## 6. 设计原则

- **不重复 Notion 的能力**: Notion 已经能干的（看 AI 字段 / 编辑 properties / 看 thread）前端要么不做要么做更好；不要"看一遍就行"水准
- **本机优先 / 离线友好**: SQLite 直读 + 附件 file:// 协议，无网络也能用（除写操作 + Notion 跳转）
- **CLI 接口对齐**: 凡是 CLI 已支持的命令，前端 UI 应是 thin wrapper（不要前端 reimplement 业务逻辑）
- **错误显式 / 不静默**: 后端 JSON wrapper error / 退出码体系直接传到 UI toast
- **操作可回放**: 写操作 log tail + 历史记录，至少能 "我刚做了什么" copy 给团队

---

## 7. Review 决策清单

请逐条确认 / 修改：

- [ ] **MVP §1.1 邮件列表** — 默认 50 条 / 页是否合理？字段选取（subject/sender/badge/date/icons/AI Action）是否合适？
- [ ] **MVP §1.2 详情页** — 默认 view 是 HTML 还是 Markdown？AI 字段是否要可编辑（V1 写操作里）?
- [ ] **MVP §1.3 搜索** — 中文 `*` 前缀提示形式（hint / 自动加 / 工具栏 toggle）?
- [ ] **MVP §1.4 设置** — DB 路径默认 `~/Documents/MailAgent/data/sync_store.db` 还是其他?
- [ ] **V1 §2.1 写操作** — toolbar 位置（详情页顶 / 右键菜单 / 命令面板）?
- [ ] **V1 §2.2 看板** — 是否复用现有 webhook-server dashboard.html 的端点（`/dashboard/api/stats`）走远程, 还是本机直读？
- [ ] **V1 §2.3 LLM dashboard** — Cost 估算 USD 用什么定价表（CRS 网关 vs 原生 Anthropic vs 各家）?
- [ ] **V1 §2.4 线程** — 是侧边栏（sidebar）还是单独路由（`/thread/:id`）?
- [ ] **V1 §2.6 日程** — 走 CLI calendar expand 还是直读 Notion calendar DB（API call）?
- [ ] **V2** 哪些要提到 V1 / 哪些 V2 也不做?
- [ ] **整体节奏** — 是 MVP ship 后立刻 V1，还是 MVP 用一段时间 reality check 后再 V1?

---

## 8. 信息架构 + 用户流

### 8.1 顶层导航 (Sidebar / Tab Bar)

```
┌─ Sidebar (240px, collapsible to icon-only 56px) ──────────┐
│                                                            │
│  ⊙ MailAgent          ←─ logo + 版本                       │
│  ─────────────────────                                     │
│  📨 Inbox  收件箱 (32) ←─ unread count badge               │
│  📤 Sent   发件箱                                          │
│  🔖 Flagged 已标旗     ←─ 跨邮箱 filter                    │
│  📁 All Mail                                               │
│  ─────────────────────                                     │
│  🔍 Search             ←─ cmd+k 快捷                       │
│  📅 Calendar                                               │
│  ─────────────────────  ← V1+ 区域                          │
│  🤖 LLM Dashboard                                          │
│  📊 Admin (Health/DL)                                      │
│  ─────────────────────                                     │
│  ⚙️ Settings           ←─ 底部                              │
│  ❓ Help (?)                                               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 8.2 主区三栏布局 (mail-style)

```
┌─Sidebar──┬─Email List (320px)──────┬─Detail Pane (flex)──┐
│ Inbox  ▮ │ ⊙ Quick Filter Bar     │  ← Back to list     │
│ Sent     │ ─ Unread Only          │  ─────────────────  │
│ ...      │ ─ Flagged              │  Subject (h1)       │
│          │ ─ Has Attachments      │  From: ... To: ...  │
│          │ ─ Date range           │  Date: ... [AI]     │
│          │ ─────────────────────  │  ─ Thread Sidebar ─ │
│          │ Subject preview...     │  HTML body iframe   │
│          │ sender · date · 🔖     │  (sandboxed)        │
│          │ ─────────────────────  │  ─ Attachments ─    │
│          │ Subject 2...           │  📎 file.pdf 1.2MB  │
│          │ ...                    │  ─ AI Fields ─      │
│          │                        │  Action: Reply Needed│
│          │ (virtualized scroll)   │  Priority: Urgent   │
│          │                        │  ─ Toolbar (V1) ─   │
│          │                        │  [Resync] [AI Rerun]│
└──────────┴────────────────────────┴─────────────────────┘
```

**响应式**: 窗口 <800px 时 Detail 占满, list 收成 hamburger drawer。

### 8.3 用户主流程

#### Flow A: 看邮件 (最高频)

```
启动
  ↓
[首次] /settings 填 API key  ──→  ping mailagent admin health
  ↓ (success)
/  (Inbox 默认)
  ↓ 5s 轮询发现 N 封新邮件
  ↓ toast "3 封新邮件" + list 顶部 new badge
  ↓ 点击邮件
/email/:id (HTML body + AI + 附件)
  ↓ 滚动看正文
  ↓ 点击线程节点 → 跳兄弟邮件
/email/:sibling-id
  ↓ j/k 上下翻邮件 (不离开 detail)
```

#### Flow B: 搜索 (中频)

```
任意页面
  ↓ cmd+k
/search?q=...
  ↓ 输入 query (FTS5 语法 hint)
  ↓ 结果 list 显示 snippet
  ↓ 点击结果
/email/:id (高亮搜索词)
  ↓ ← back 回搜索 list (保留 query state via URL)
```

#### Flow C: 写操作 (V1, 低频高价值)

```
/email/:id
  ↓ 看到 AI Action 是 "Reply Needed" 但 Notion 没字段
  ↓ 点 [AI Rerun] 按钮
弹 confirm dialog "重跑 LLM 会覆盖已有字段?"
  ↓ Yes
  ↓ progress bar (CLI fork + stream stdout)
  ↓ success toast "AI 字段已更新" + invalidate query → UI 自动刷
  ↓ 继续浏览
```

#### Flow D: 健康检查 (运维, 偶发)

```
/admin
  ↓ 看 Health card 红色 (mailagent admin health failed)
  ↓ 看 Dead-letter list 有 5 封
  ↓ 点击 retry 单封
  ↓ 进度 + log → success / next failure
  ↓ 切到 /llm 看 cost 是否异常
  ↓ 切到 SyncStore 状态分布饼图看 fetch_failed 多不多
```

### 8.4 状态机 (邮件视角)

```
[backend 视角]
fetched → synced ───→ AI Reviewed ───→ 已同步 ───→ 已完成
       ↓                    ↑              ↓ user mark
   fetch_failed          (LLM)           (Mail.app 取消旗标)
       ↓
   dead_letter

[前端视角 — 每个邮件 row 显示]
- new (sync_status='synced' 且 updated_at < 1h): 蓝点 + 加粗
- unread (is_read=false): 加粗
- flagged (is_flagged=true): 🔖
- has_attachments: 📎
- ai_processed (AI Action != null): 标签 (颜色按 priority)
- error (sync_status='failed'): 红 ⚠
- dead (sync_status='dead_letter'): 灰 + "⚠ Dead" badge
```

### 8.5 跨页面状态保留

| 状态 | URL 表达? | localStorage? | Zustand? |
|---|---|---|---|
| 当前 mailbox | ✅ `/mailbox/:name` | - | - |
| 搜索 query | ✅ `?q=...` | ✅ 历史 10 条 | - |
| Filter (unread/flag/date) | ✅ `?filter=...` | - | - |
| 当前邮件 | ✅ `/email/:id` | - | - |
| Theme | - | ✅ | ✅ (subscribe) |
| Sidebar collapsed | - | ✅ | ✅ |
| API key | - | macOS Keychain | - |
| TanStack Query cache | - | (sessionStorage opt) | (query client) |

URL-as-source-of-truth 让用户可以分享 link / 浏览器历史可用 / 多窗口独立。

---

## 9. 动效场景清单

> **视觉风格 + 具体动效细节留给 claude design / frontend-design skill 做**。
> 本节只列 "哪些场景需要动效 + 期望感觉"，不规定具体 timing / easing。

### 9.1 必做动效 (MVP)

| 场景 | 期望感觉 | 类型 | 建议 |
|---|---|---|---|
| 邮件列表新邮件到达 | "刚到了" 但不打扰 | slide-in + 蓝点 fade | 顶部 push 200-300ms ease-out, 不抢焦点 |
| 邮件 list ↔ detail 切换 | 流畅承接，不突兀 | crossfade 或 horizontal slide | 150-200ms |
| Loading skeleton | "在加载，不是卡死" | shimmer / pulse | Tailwind 自带 animate-pulse |
| Toast 通知 (success / error / info) | 及时反馈，自动消失 | slide-in top + fade-out | 3s 后 fade |
| Toolbar 按钮 hover | "可点击" | scale 1.02 + shadow | 100ms |
| 长任务 progress | "在跑，进度可见" | linear progress bar + log scroll | 实时 stream |

### 9.2 推荐动效 (V1)

| 场景 | 期望感觉 | 类型 |
|---|---|---|
| Sidebar collapse / expand | 平滑伸缩 | width transition 200ms |
| 三栏布局 panel resize 拖拽 | 跟手 | 实时 width 跟随 mouse |
| 搜索结果 snippet 高亮 | "搜到了" | mark 元素淡黄 background fade-in |
| 详情页线程 sidebar 滚到当前邮件 | "你在这里" | scrollIntoView smooth + 持续 ring 200ms |
| AI 字段更新 | "刚更新" | 单个字段背景 flash 蓝色 fade |
| Dead-letter retry 成功 | 庆祝感 | 单行绿色 flash 然后从 list 消失 |
| 看板数字变化 (count up) | 数据有变 | react-spring count animation 500ms |
| Mailbox 切换 | 列表整体过渡 | crossfade 100ms (避免长 stagger) |

### 9.3 慎用 / 不做 (避免)

| 反模式 | 原因 |
|---|---|
| 全屏 splash screen | 邮件 app 启动慢的 UX 反感 |
| 每次点击都 animate | 累 + 拖速度 |
| Spring bouncy 弹簧 | 不符合"工具类"严肃感（参考 Mimestream 风格） |
| 长 stagger 列表入场 (>300ms) | 6000+ 邮件场景会"很慢" |
| Confetti / particles | 邮件 app 不需要游戏化 |
| 模态对话框过度 backdrop blur | 性能开销 + 干扰阅读 |

### 9.4 设计语言关键词 (给 claude design 用)

- **专业 / 严肃 / 工具**: 参考 Linear / Things 3 / Mimestream / Spark
- **信息密度高**: 邮件列表 1 行容纳 subject+sender+date+icons，不是 card 风格
- **本机感**: 与 macOS 原生 Mail.app / Notion / VS Code 风格协调（vibrancy / blur / inset shadow）
- **中文友好**: 字号 13-14px 中文不会糊（Tailwind 默认 text-sm 是 14px ✓），字重对比 (medium for label / regular for body)
- **暗色优先**: 邮件长时间阅读，dark mode 是首选；light mode 也支持
- **品牌色**: 留给你定（建议: 系统蓝 #007AFF 或 Notion 灰 #2C2C2C 系列基础上找一个 accent）

### 9.5 推荐参考

| App | 学什么 | 不学什么 |
|---|---|---|
| **Mimestream** (macOS Gmail client) | 三栏布局 / 信息密度 / 本机感 | 颜色偏淡 |
| **Spark / Superhuman** | 键盘流 / quick action | 复杂度太高 |
| **Linear** | toolbar / cmd+k / 动效克制 | 偏 web 风 |
| **Notion** | sidebar / breadcrumb | 加载慢 |
| **VS Code** | 命令面板 / panel resize / 状态栏 | 主题选项过多 |

---

> 本 spec 与 [`frontend-v1-tech-tradeoffs.md`](./frontend-v1-tech-tradeoffs.md) 配套
> review，决策完了起 prd.json 进 Sprint 实施。
>
> 视觉风格 / 具体动效 / 组件 mockup 留给 `claude design` (frontend-design skill) 做。
