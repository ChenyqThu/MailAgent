# MailAgent Web — 产品方案 & 开发计划

> 版本: v2.1 | 创建: 2026-05-10 | 更新: 2026-05-11 | 状态: Sprint 4 完成，邮件分层视图方案设计中

## 产品定位

**两个独立页面**，解决两类不同场景：

| 页面 | 用户场景 | 核心价值 |
|------|---------|---------|
| **Dashboard** (`/`) | 每天第一眼：今天有什么邮件要处理？系统健不健康？ | 全局概览 + 快速分流 |
| **工作台** (`/inbox`) | 逐封处理邮件：读正文、看 AI 分析、操作、AI 辅助 | 深度处理 + AI 交互 |

## Dashboard 产品方案

**目标**：30 秒内掌握邮件全貌，1 分钟内完成分流。

### 布局（上下结构）

```
┌──────────────────────────────────────────────────────────┐
│ MailAgent            Dashboard  工作台           Kevin ▾  │ ← 导航栏
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐          │
│  │待处理  │ │紧急    │ │今日新增│ │AI已审 │ │LLM 成本│          │ ← 统计卡片行
│  │  12   │ │  2    │ │  28   │ │  25   │ │ $0.42 │          │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘          │
│                                                          │
│  ┌─────────────────────────┐ ┌────────────────────────┐  │
│  │ 需要关注（紧急+重要）       │ │ 今日摘要 (Daily Digest)  │  │
│  │ ┌─ 🔴 Re: DDL 确认       │ │ 收到 28 封，AI 处理 25   │  │
│  │ │  Momo · 需要回复 · 2h前  │ │ 紧急 2 · 重要 8 · 一般 15│  │
│  │ ├─ 🔴 合同审批              │ │                        │  │
│  │ │  Julian · 需要决策 · 4h前 │ │ 热门话题:               │  │
│  │ ├─ 🟡 AI QoS Phase 2     │ │ · AI QoS 优先级 (3封)   │  │
│  │ │  Julian · 需要决策 · 5h前 │ │ · 2027 画册提报 (2封)   │  │
│  │ └─ ...                    │ │ · 项目进度周报 (1封)     │  │
│  │         → 进入工作台处理     │ │                        │  │
│  └─────────────────────────┘ └────────────────────────┘  │
│                                                          │
│  ┌─────────────────────────┐ ┌────────────────────────┐  │
│  │ 系统状态                   │ │ 处理趋势 (7天)          │  │
│  │ 同步: ✅ 正常 · 5924封     │ │ ▁▂▄▆█▅▃              │  │
│  │ LLM: ✅ 25/28 成功        │ │ 每日平均: 32封          │  │
│  │ Redis: ✅ 已连接           │ │ 缓存命中: 87%          │  │
│  │ 上次同步: 2分钟前           │ │                        │  │
│  └─────────────────────────┘ └────────────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Dashboard 功能清单

1. **统计卡片**：待处理数 / 紧急数 / 今日新增 / AI 已审核 / LLM 成本
2. **需要关注列表**：紧急+重要邮件，点击直达工作台对应邮件
3. **今日摘要**：按主题/项目聚合的当日邮件概览
4. **系统状态**：同步状态 / LLM 状态 / Redis 状态 / 最后同步时间
5. **处理趋势**：7 天邮件量折线图 + 缓存命中率

## 工作台产品方案

**目标**：像 Superhuman 一样高效处理邮件，AI 深度嵌入每一步。

### 布局（三栏可调）

```
┌──────────────────────────────────────────────────────────┐
│ MailAgent            Dashboard  工作台           Kevin ▾  │
├────────────┬─────────────────────────────────────────────┤
│ 过滤器       │ 邮件主题                      收起 ▲      │
│ 全部 紧急    │ From: xxx  To: xxx  2h前                  │
│ 重要 需回复  │ 🔴紧急 · 需要回复 · 团队协作                │
│            │ ┌ ✓已处理  ⚑旗标  ○已读  ▼归档 ┐            │
│ ┌──────┐   ├─────────────────────────────────────────────┤
│ │🔴 DDL │   │ 正文区域（Notion 正文，可调整高度）           │
│ │确认    │   │                                            │
│ │Momo 2h │   │ Hi Kevin,                                 │
│ ├──────┤   │ 关于 2027 年度画册机型提报...                  │
│ │🟡 AI  │   │                                            │
│ │QoS    │   │                                            │
│ │Julian │   │ ═══════════════ 可拖拽 ════════════════════ │
│ ├──────┤   │                                            │
│ │🟢 周报 │   │ 🤖 AI  翻译  总结  起草回复                 │
│ │System │   │ ┌────────────────────────────────┐         │
│ │       │   │ │ 输入自定义指令...          发送  │         │
│ └──────┘   │ ├────────────────────────────────┤         │
│            │ │ AI 结果会显示在这里              │         │
│ ◀ 上一页   │ │                                │         │
│   第1页    │ └────────────────────────────────┘         │
│ 下一页 ▶   │                                            │
└────────────┴─────────────────────────────────────────────┘
```

### 工作台核心交互

1. **列表 ↔ 详情联动**：点击或 J/K 切换，右侧实时加载
2. **正文懒加载**：从 Notion API 按需获取，5min 客户端缓存
3. **正文/AI 可拖拽分割**：中间拖拽条调整上下比例
4. **头部可折叠**：点击标题行收起元数据+AI字段，最大化正文空间
5. **AI 面板常驻**：翻译/总结/起草/自定义指令，结果填满底部空间
6. **操作按钮**：已处理/旗标/已读/归档 → Redis → Notion + Mail.app

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│ MacBook Pro（单机部署）                                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  MailAgent main.py (PM2: mail-sync)  ←→  sync_store.db (WAL)       │
│        ↑ 写                                  ↓ 只读                  │
│        │                                     │                      │
│  Redis queue ←──────── Web API (:8200) ←──── React SPA             │
│        │                   ↑ SSE               ↕ 路由               │
│        │                   │              Dashboard / 工作台         │
│        ↓                   │                                        │
│  EventHandlers ─────→ Notion / Mail.app / 飞书                      │
│                            ↑                                        │
│  Notion API ──────── 正文读取（blocks.children.list）                │
│                                                                     │
│  CRS Gateway ←── Web API /api/agent 端点                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| 前端 | React 19 + Vite 6 + Tailwind | 轻量，AI coding 友好 |
| 路由 | React Router v7 | Dashboard / 工作台双页面 |
| 后端 | FastAPI :8200 | 与 MailAgent 解耦 |
| 实时 | SSE | 单向推送够用 |
| 数据库 | sync_store.db `?mode=ro` | 只读 |
| 正文 | Notion API (blocks.children.list) | 按需加载，前端 5min 缓存 |
| 队列 | Redis DB2 | 复用 EventHandlers |
| AI | CRS 网关 (Anthropic Messages API) | 复用 prompt caching |
| 认证 | Bearer token | 内网 + token |
| 部署 | PM2 + Tailscale | 复用基础设施 |
| 托管 | FastAPI StaticFiles | 无需 nginx |

## 项目结构

```
web/
├── api/
│   ├── main.py
│   ├── config.py
│   ├── deps.py
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── emails.py          # GET /emails, GET /emails/:id, GET /emails/:id/body
│   │   ├── actions.py         # POST /emails/:id/action
│   │   ├── agent.py           # POST /emails/:id/agent (翻译/总结/起草/自定义)
│   │   ├── dashboard.py       # GET /dashboard/stats, /dashboard/attention, /dashboard/digest
│   │   ├── events.py          # GET /events (SSE)
│   │   └── stats.py           # GET /stats
│   ├── services/
│   │   ├── db.py
│   │   ├── email_service.py
│   │   ├── notion_service.py  # Notion 正文读取
│   │   ├── redis_service.py
│   │   └── dashboard_service.py
│   └── models/
│       ├── common.py
│       ├── email.py
│       └── action.py
├── frontend/
│   └── src/
│       ├── main.tsx
│       ├── router.tsx             # 路由配置
│       ├── lib/
│       │   ├── api.ts
│       │   ├── types.ts
│       │   └── constants.ts
│       ├── hooks/
│       │   ├── useEmails.ts
│       │   ├── useEmailDetail.ts
│       │   ├── useEmailBody.ts
│       │   ├── useDashboard.ts
│       │   ├── useKeyboard.ts
│       │   └── useSSE.ts
│       ├── pages/
│       │   ├── DashboardPage.tsx
│       │   └── InboxPage.tsx      # 原 App.tsx 拆出
│       └── components/
│           ├── layout/
│           │   └── NavBar.tsx     # 顶部导航（Dashboard / 工作台切换）
│           ├── dashboard/
│           │   ├── StatCards.tsx
│           │   ├── AttentionList.tsx
│           │   ├── DailyDigest.tsx
│           │   ├── SystemStatus.tsx
│           │   └── TrendChart.tsx
│           ├── email-list/
│           │   ├── EmailList.tsx
│           │   ├── EmailRow.tsx
│           │   └── FilterBar.tsx
│           └── email-detail/
│               ├── DetailPanel.tsx
│               ├── MetadataHeader.tsx
│               ├── AIFieldsCard.tsx
│               ├── ActionBar.tsx
│               └── AgentPanel.tsx
└── ecosystem.config.js
```

---

## Sprint 计划（修订版）

### ~~Sprint 1（已完成）：后端骨架~~

**交付物**：FastAPI 应用 + 邮件列表 API + 统计 + SSE + 认证

---

### ~~Sprint 2（进行中 → 本轮完成）：前端 MVP~~

**已完成**：邮件列表 + 详情面板 + AI 面板 + 正文 Notion 加载 + 可拖拽分割

**本轮收尾**：
- 加入 react-router，拆分 Dashboard / 工作台两个页面
- 工作台 = 现有 App.tsx 搬到 InboxPage
- Dashboard = 新页面，接 dashboard API
- 顶部导航栏

---

### Sprint 3：Dashboard 页面

**目标**：打开首页 30 秒掌握邮件全貌。

**后端**：
- `GET /api/dashboard/stats` — 待处理数、紧急数、今日新增、AI 已审、LLM 成本
- `GET /api/dashboard/attention` — 紧急+重要邮件列表（前 10 封）
- `GET /api/dashboard/digest` — 今日摘要（按主题聚合）
- `GET /api/dashboard/system` — 系统状态（同步/LLM/Redis）
- `GET /api/dashboard/trend` — 7 天处理趋势

**前端**：
- `StatCards.tsx` — 5 个统计卡片
- `AttentionList.tsx` — 需要关注列表，点击跳转工作台
- `DailyDigest.tsx` — 今日摘要
- `SystemStatus.tsx` — 系统健康
- `TrendChart.tsx` — 7 天趋势（纯 CSS/SVG，不引图表库）

**验收**：
- [ ] `/` 显示 Dashboard，2s 内全部数据加载完
- [ ] 点击紧急邮件 → 跳转 `/inbox?id=xxx`
- [ ] 统计数据与 SQLite 一致

---

### Sprint 4：工作台增强

**目标**：全部快捷键 + 批量操作 + 搜索。

**交付物**：
- 快捷键完整：e(完成) s(旗标) r(已读) /(搜索) ?(帮助) x(多选)
- 批量选择 + 批量完成/归档
- 搜索栏（subject + sender 本地过滤）
- AI 字段 inline 编辑（点击 Priority → 下拉修改）
- Notion deep link（点击跳转 Notion 页面）

**验收**：
- [ ] x 多选 → 批量完成 → 10 封同时处理
- [ ] 点击 Priority → 下拉修改 → Notion 同步
- [ ] / 搜索框可搜 subject + sender
- [ ] 全部快捷键在 ? 帮助面板有说明

---

### Sprint 5：邮件分层视图

**问题**：当前工作台只有"待处理"（is_flagged=1）和"全部"两个视图。未标旗的邮件全堆在一起，无法区分"日常项目更新值得扫一眼"和"订阅通知完全不用看"。

**现状分析**：数据层已有区分信号，但前端没用起来。

| 信号 | 值得浏览 | 可忽略 |
|------|---------|--------|
| Action Type | 仅供参考 | 仅供参考 |
| Priority | 🟢 一般 / 🟡 重要 | ⚪ 低 |
| Mail Actions | ✅ Marked as Read | 🗑️ Archived |
| action_required | false | false |

**方案**：不拆 Action Type（避免冗余表达），用 **Priority + action_required 组合** 在前端做三层分流。

#### 三层视图定义

| 视图 | 筛选条件 | 含义 | 默认 |
|------|---------|------|------|
| **待处理** | `is_flagged=1` | AI 认为需要你行动 | ✅ 默认 |
| **值得浏览** | `is_flagged=0` + `action_type=仅供参考` + `priority IN (🟢, 🟡)` | 有信息价值，空闲时扫一眼 | |
| **可忽略** | `is_flagged=0` + `priority=⚪ 低` | 订阅/系统通知/低相关，不用看 | |
| **全部** | 无过滤 | 搜索/回溯用 | |

#### 前端改动

**FilterBar.tsx**：视图切换从 2 个（待处理/全部）→ 4 个 tab

```
[ 待处理 12 ] [ 值得浏览 8 ] [ 可忽略 15 ] [ 全部 35 ]
```

- "值得浏览"和"可忽略"作为组合筛选条件，不是单个字段过滤
- 保留现有快捷过滤标签（紧急/重要/需要回复等），在任何视图下都能叠加

**useEmails.ts**：新增 `view` 参数，映射为后端 API 查询条件

#### 后端改动

**方案 A（推荐）：前端组合查询，后端不改**

前端把视图映射为现有的 `priority` + `action_type` + `is_flagged` 参数组合，后端 API 不需要改。

问题：当前后端 `priority` / `action_type` 是后过滤（Python 层遍历 labels_json），"值得浏览"需要 `priority NOT IN ('⚪ 低')`，现有 API 不支持 NOT IN。

**方案 B：后端加 `view` 参数**

`GET /emails?view=browse` — 后端直接识别视图语义，在 SQL + 后过滤层处理组合条件。
- `view=pending`：`is_flagged=1`（现有逻辑）
- `view=browse`：`is_flagged=0` + priority 非 ⚪ 低 + action_type=仅供参考
- `view=ignore`：`is_flagged=0` + priority=⚪ 低
- `view=all`：无过滤

**推荐方案 B**，因为：
1. 组合筛选语义复杂，前端拼参数容易出错
2. 后端可以在 SQL 层做 count，前端 tab 上显示各视图的数量
3. 未来调整分层规则只改后端，不用动前端

#### 后端具体改动（方案 B）

1. **`web/api/models/email.py`**：`EmailFilter` 增加 `view: Optional[str]` 字段
2. **`web/api/routes/emails.py`**：接收 `view` query param
3. **`web/api/services/email_service.py`**：
   - `list_emails()` 根据 view 映射 SQL 条件 + 后过滤条件
   - 新增 `get_view_counts()` → 返回各视图邮件数量（供 tab badge 用）
4. **`web/api/routes/emails.py`**：新增 `GET /emails/view-counts` 端点

#### 前端具体改动

1. **`FilterBar.tsx`**：视图 tab 改为 4 个，每个带 count badge
2. **`useEmails.ts`**：`EmailFilter` 增加 `view` 字段，传给后端
3. **新增 `useViewCounts.ts`**：轮询 `/emails/view-counts`，驱动 tab badge
4. **`InboxPage.tsx`**：默认 view=pending，URL 同步 `?view=browse`

#### Prompt 微调（可选但推荐）

当前 `prompts/email_inbox.md` 的 Priority 判定已经有明确语义：
- `🟢 一般` = 日常项目更新、例行同步、一般讨论
- `⚪ 低` = 纯 FYI、订阅通知、低相关度系统邮件

建议强化 prompt 里这段的判定标准，增加几个典型案例，让 LLM 分得更准：
- `🟢 一般`：项目周报、团队进度同步、技术方案讨论（非直接 @你）、重要人物的群发邮件
- `⚪ 低`：Jira/Confluence 自动通知、HR 公告、订阅 newsletter、自动报表、系统告警（非你负责的）

**验收**：
- [ ] 4 个视图 tab 各自显示正确数量
- [ ] "待处理"= 现有逻辑不变
- [ ] "值得浏览"只显示非旗标、非低优先级的仅供参考邮件
- [ ] "可忽略"只显示 ⚪ 低优先级邮件
- [ ] 快捷过滤标签在任意视图下可叠加
- [ ] URL 同步视图状态（刷新不丢失）

---

### Sprint 6：AI 增强 + 线程

**目标**：AI 深度嵌入处理流程。

**交付物**：
- 选中文本翻译浮层
- AI 回复草稿 → 编辑 → 发送到 Mail.app
- 线程视图（同 thread_id 折叠显示）
- Re-analyze 按钮（重跑 LLM 分析）
- 自由提问支持上下文对话

**验收**：
- [ ] 翻译 <2s
- [ ] 草稿 → Mail.app 草稿箱
- [ ] 线程折叠/展开正确
- [ ] 对话支持多轮

---

### Sprint 7：打磨 + PWA

**目标**：生产可用，移动端可访问。

**交付物**：
- 响应式（平板/手机自适应）
- 深色/浅色主题
- PWA（离线缓存已加载邮件）
- 错误边界 + 空状态中文提示
- 飞书通知 deep link → Web
- CLAUDE.md 更新

**验收**：
- [ ] iPad 横屏布局合理
- [ ] 离线可查看已缓存邮件
- [ ] 所有空状态有中文引导

---

## 当前进度

| Sprint | 状态 | 说明 |
|--------|------|------|
| 1 后端骨架 | ✅ 完成 | API + SSE + Auth |
| 2 前端 MVP | ✅ 完成 | 列表+详情+AI+正文+路由+导航 |
| 3 Dashboard | ✅ 完成 | 统计卡片+关注列表+摘要+系统状态+趋势图 |
| 4 工作台增强 | ✅ 完成 | 快捷键 e/s/r/x/?/搜索+批量操作+Notion链接+帮助面板 |
| 5 邮件分层视图 | 📋 方案设计中 | 三层分流：待处理/值得浏览/可忽略 |
| 6 AI 增强 | 待启动 | 线程视图+翻译+草稿+多轮对话 |
| 7 打磨 PWA | 待启动 | 响应式+深浅主题+PWA+错误边界 |

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Notion API 正文加载慢 | 前端 5min staleTime 缓存 + loading skeleton |
| SQLite WAL 锁 | `?mode=ro` + PRAGMA query_only |
| CRS 网关不稳 | 超时 30s + 错误提示 |
| MacBook 合盖 | 防休眠 + 文档说明 |

## 成功标准

| 指标 | 目标 |
|------|------|
| Dashboard 加载 | < 2s |
| 邮件列表（100封） | < 300ms |
| 正文加载（Notion） | < 1s |
| AI 翻译 | < 3s |
| 单封处理（快捷键流） | < 3s |
| 全部 UI | 中文 |
