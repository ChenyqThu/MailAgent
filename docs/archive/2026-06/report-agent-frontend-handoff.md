# 邮件报告 Agent + Custom AI 区 — 前端设计 Handoff（for Claude Design）

> **怎么用这份文档**：你要设计并实现 MailAgent 桌面 app（Electron + React + TanStack Router）里一个**新的「Agents / Custom AI」区**，核心是**邮件报告 agent**（日报为主）的查看 + 配置界面，并把现有 AI 对话历史并入。**后端（Python 生成报告 + Electron main 提供数据 IPC）由另一条线实现，你只负责 renderer 层的界面设计 + 实现**。产品上下文见 [report-agent-prd.md](report-agent-prd.md)。本文件聚焦你需要的：信息架构、屏、组件、状态、**数据契约**、可复用资产、约束。

---

## 1. 背景（一段话）

MailAgent 把邮件同步到本地 + AI 自动分类 / 优先级 / 摘要 / 动作建议。用户（Lucien，单人）缺一个"综合昨天邮件、可溯源、好查看"的**日报**。我们做一个**报告 agent**：每天定时由后端 LLM 生成一份**结构化报告**（不是纯文本，是块模型 JSON），在 app 内查看，每封邮件**可点击溯源**。日 / 周 / 月报同引擎。顺带把现有"AI 对话历史"并进这个区。

---

## 2. 入口与信息架构

**现状**：左侧 Sidebar 有 `AI AGENTS` 段，含三行：`Notion Agent` / `Custom AI` / `AI 会话历史`。其中 `Custom AI` 现在只是打开右侧聊天面板（无独立页）。

**改造**：把 `Custom AI` 做成**独立页面 `/agents`**（新路由，仿现有 `/sessions`）。这是新区的主场。

**`/agents` 页 = 顶部 tab 切三个模块**：
1. **Agents** —— agent 列表 / 卡片（v1 就 1 个：邮件日报；预留多 agent）。
2. **报告 Reports** —— 历史报告列表 + 报告详情查看。**新主角**。
3. **Chats** —— 复用现有 `SessionsPage`（AI 会话历史）作为一个 tab。

> "chats 历史只是其中一个模块" —— 视觉上别让 Chats 占主导，**Agents + 报告是新主角**。

---

## 3. 要设计的屏 + 组件 + 状态

### 3.1 Agents tab（概览）
- **agent 卡片**（邮件日报）：名称 + 图标、**启用开关**、排程摘要（"每天 09:00"）、最近一次报告（时间 + headline + 点击进详情）、下次运行时间、**「立即运行 Run now」**、进**配置**入口。
- 空态：未启用任何 agent → 引导启用。
- 预留 "+ 新建 agent"（v1 可灰 / 隐藏，但布局预留位）。

### 3.2 报告 tab（列表 + 详情）
**列表**：日期倒序的报告项 —— 日期、cadence 标签（日 / 周 / 月）、headline、状态 badge（已就绪 / 生成中 / 失败 / 空）、统计小数字（"32 封 · 3 紧急"）。筛选：cadence。

**详情 = BlockRenderer（核心组件）**：报告是一个 `ReportDoc`（块数组，契约见 §5）。**为每种 block 设计一个组件**。重点：
- `email_item`（邮件行）—— **日报的灵魂**：可点击 → app 内打开该邮件；显示发件人 / 时间 / 分类 / 优先级 badge / AI 一句话摘要；**溯源**有"在 Notion 打开"。
- `stat_row` —— 统计卡片组，醒目好扫。
- `section` —— 分组标题（"🔴 需要你亲自关注" / "✅ Jarvis 已处理" / "📋 FYI 已汇总"），下挂若干 `email_item`。
- `key_points` —— 要点列表（"你必须知道的关键信息"）。
- `callout` —— 高亮块（info / warn / critical 三色调）。
- `trend`（周 / 月报）—— 简单趋势图。**⚠️ 前端无图表库**，用纯 CSS bar / inline SVG（或你建议引入轻量库，需说明）。
- `kos_context` —— 知识库增强卡（可选，展示某 entity 档案片段）。
- `header` / `overview` / `divider` / `action_suggestion`（v1 动作按钮**禁用态展示**，不可点）。

**状态**：生成中（skeleton）、失败（错误 + 重试）、空（"昨天没有需要特别关注的邮件"）。

### 3.3 配置面板（agent config）
字段：启用开关、**prompt 编辑**（多行 textarea，带默认 prompt，可改 —— 用户要能调日报"口味"，是核心）、排程（cadence + 时间）、回看窗口、模型选择、KOS 增强开关。保存 / 取消。

---

## 4. Custom AI chat 的 KOS 工具调用展示（KOS 的前端唯一相关点）

KOS 接入**几乎纯后端**（chat harness 里把 KOS 原生工具注册给 LLM，调用在 main 进程）。**前端唯一相关 = chat 里的"工具调用展示"**。
- 现状：chat 已有基础工具调用展示（`MessageList.tsx` 里 Sprint 19 的 `chat_tool_call` 审计卡，显示工具名 + input/output JSON 折叠）。KOS 工具调用会自动走这套。
- **设计任务（可选但推荐）**：升级成类似 **Claude Code** 的体验 —— 一行简洁 chip / 卡（图标 + 人话动作 + 可展开详情），区分进行中 / 成功 / 失败：
  - "🔍 检索知识库：供应商合同条款" → 展开看 query 参数 + 命中结果
  - "📄 读取档案：companies/elkjp"
- 属于这次"Custom AI 区重设计"的一部分，与报告区并行。

---

## 5. 数据契约：ReportDoc 块模型（照这个渲染）

```ts
type Tone = 'neutral' | 'info' | 'success' | 'warn' | 'critical';

interface ReportDoc {
  version: 1;
  agent_id: string;                       // "daily_email_digest"
  cadence: 'daily' | 'weekly' | 'monthly';
  report_date: string;                    // "2026-06-01"
  window: { start: string; end: string }; // ISO
  generated_at: string;                   // ISO
  model: string;
  blocks: Block[];
}

type Block =
  | { type: 'header'; title: string; subtitle?: string; date_label?: string }
  | { type: 'overview'; text: string }
  | { type: 'stat_row'; stats: { key: string; label: string; value: number; tone: Tone }[] }
  | { type: 'section'; id: string; title: string; icon?: string; intro?: string }
  | { type: 'email_item'; internal_id: number; subject: string; sender_name: string;
      sender_addr?: string; time: string; category?: string; priority?: string;
      ai_summary?: string; ai_action?: string;
      source: { notion_url?: string; app_deeplink?: string }; badges?: string[] }
  | { type: 'key_points'; title?: string; items: string[] }
  | { type: 'callout'; tone: Tone; title?: string; body: string }
  | { type: 'kos_context'; entity_slug: string; title: string; snippet: string; source: string }
  | { type: 'action_suggestion'; id: string; title: string; detail?: string;
      internal_ids: number[]; action_type: string; enabled: false }  // v1 禁用态展示
  | { type: 'trend'; metric: string; points: { label: string; value: number }[];
      compare?: { label: string; delta: number } }
  | { type: 'divider' };
```

**未知 `type` 必须优雅降级**（跳过或纯文本），方便后端将来加新块不崩前端。

**一份真实日报示例**（数据取自真实 KOS / 邮件，仅供你设计参考）：

```json
{
  "version": 1, "agent_id": "daily_email_digest", "cadence": "daily",
  "report_date": "2026-06-01",
  "window": { "start": "2026-05-31T09:00:00+08:00", "end": "2026-06-01T09:00:00+08:00" },
  "generated_at": "2026-06-01T09:01:23+08:00", "model": "claude-sonnet-4-6",
  "blocks": [
    { "type": "header", "title": "邮件日报", "subtitle": "2026年6月1日 · 过去 24 小时", "date_label": "周一" },
    { "type": "overview", "text": "昨天共 32 封邮件，Jarvis 已自动处理 28 封；有 3 封紧急邮件需要你亲自跟进，主要围绕 Elkjøp 北欧标案的 PoC 排期。" },
    { "type": "stat_row", "stats": [
      { "key": "total", "label": "总邮件", "value": 32, "tone": "neutral" },
      { "key": "unread", "label": "未读", "value": 5, "tone": "info" },
      { "key": "urgent", "label": "紧急", "value": 3, "tone": "critical" },
      { "key": "ai_handled", "label": "AI 已处理", "value": 28, "tone": "success" },
      { "key": "todo", "label": "待你处理", "value": 4, "tone": "warn" }
    ]},
    { "type": "section", "id": "attention", "title": "需要你亲自关注", "icon": "alert", "intro": "这 3 封 AI 判断需要你决策或回复：" },
    { "type": "email_item", "internal_id": 51694,
      "subject": "RE: 【S2】北欧 Elkjøp 标案 PoC 排期确认", "sender_name": "Michael Svoldgaard",
      "sender_addr": "michael.s@elkjop.no", "time": "2026-05-31T18:42:00+08:00",
      "category": "🤝 商务合作", "priority": "🔴 紧急",
      "ai_summary": "对方要求本周五前确认 PoC 设备到货时间，否则影响决赛圈评估。", "ai_action": "需要回复",
      "source": { "notion_url": "https://www.notion.so/xxxxxxxx", "app_deeplink": "mailagent://email/51694" },
      "badges": ["需回复", "本周截止"] },
    { "type": "section", "id": "handled", "title": "Jarvis 已处理", "icon": "check", "intro": "已自动分类归档，无需你操作：" },
    { "type": "email_item", "internal_id": 51332,
      "subject": "[Global Support] Ticket #104634 状态更新", "sender_name": "TP-Link Support",
      "time": "2026-05-31T14:10:00+08:00", "category": "🔔 系统通知", "priority": "🟢 一般",
      "ai_summary": "工单进展通知，已自动归档。", "ai_action": "仅供参考",
      "source": { "notion_url": "https://www.notion.so/yyyyyyyy", "app_deeplink": "mailagent://email/51332" } },
    { "type": "key_points", "title": "你必须知道的关键信息", "items": [
      "Elkjøp PoC 设备需本周五前确认到货，Michael 在等你回复。",
      "Telekom Malaysia JENDELA 2 标案需求仍未锁定，研发排期承压。"
    ]},
    { "type": "callout", "tone": "warn", "title": "本周截止", "body": "Elkjøp PoC 排期确认（周五 6/5）。" },
    { "type": "kos_context", "entity_slug": "companies/elkjp", "title": "Elkjøp 北欧标案",
      "snippet": "≥120 万欧元、400+ 门店、8000+ 设备，已进 PoC 决赛圈，Omada 首家执行测试。", "source": "KOS" },
    { "type": "divider" }
  ]
}
```

---

## 6. 可复用资产 / 设计系统

- **现有视觉参考**：repo 根目录 live 截图 —— `live-inbox-01.png` / `live-kanban-desktop.png` / `live-settings-desktop.png` / `live-llm-desktop.png` / `live-inbox-mobile-390.png`。**务必匹配现有设计语言**。
- **复用组件**：Sidebar（`AI AGENTS` 段）、`SessionsPage`（Chats tab 直接复用）、邮件正文 iframe `EmailBodyFrame`、主题 token（深 / 浅 / accent CSS 变量）、TanStack Router（加 `/agents` 仿 `/sessions`）。
- **markdown**：renderer 有 Vercel `Streamdown`（chat 在用），可复用渲染富文本段（如 overview / key_points）。
- 字体 / 间距 / 圆角 / 动效跟现有一致（项目有 GSAP 动效规范）。

---

## 7. 约束

- **无图表库**（package.json 无 recharts / d3 / chart.js）→ `trend` 用纯 CSS / inline SVG，或你建议引入轻量库（说明理由）。
- **主题**：深 / 浅 / accent 必须跟随。
- **响应式**：app 有桌面 + 窄屏（mobile）布局（见 `live-inbox-mobile-390.png`），报告详情要能窄屏看。
- **性能**：报告可能含几十个 `email_item`，列表要顺滑（项目有列表性能铁律，见 `frontend/ARCHITECTURE.md` §7）。

---

## 8. 不在你范围内

- 报告怎么生成（后端 Python LLM）。
- 数据怎么来：Electron main 提供 IPC（`report:list` / `report:get` / `report:runNow` / `report:getConfig` / `report:setConfig`）。**你按 §5 契约拿到 `ReportDoc` 渲染即可**（开发期可用 §5 示例 JSON 做 mock）。
- KOS 工具桥本身（后端）。

---

## 9. 期望交付

1. `/agents` 页三 tab 完整设计 + 实现（React，接 §5 契约 + IPC mock）。
2. **BlockRenderer**（§5 全部 block 组件 + 未知块降级）。
3. agent 配置面板。
4. （推荐）chat 工具调用展示升级（§4，Claude Code 风格）。
5. 各状态（空 / 加载 / 失败）+ 深浅主题 + 窄屏。
