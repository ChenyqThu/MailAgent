# 灵动岛 Ping Island — F1-F6 ship 完工 + 下一步 Handoff

> **状态**：✅ Phase 1 + Phase 2 + F1-F6（按钮真实化）全部 ship 到 `feat/agent-harness`（2026-05-26）。下个 session 直接读本文上手。
>
> **关联**：
> - PRD: `~/.claude/plans/ultrathink-session-curious-cloud.md`（4 phase 路线）
> - Phase 2 handoff: `frontend/PHASE-2-AI-SUGGESTIONS-HANDOFF.md`
> - Memory: `~/.claude/projects/.../memory/project_mailagent_ping_island_prd.md`
> - fork: `~/Documents/ping-island/`（branch `feat/mail-brand`）

---

## 0. TL;DR

灵动岛从"按钮好看但假"做到"按钮真触发业务"。**核心痛点已清零**：

| 之前 | 现在 |
|---|---|
| create_draft 类调不存在的 CLI → silent fail | `mailagent email draft` 读 **SQLite SSoT** reply_suggestion → davmail IMAP APPEND 真起草 |
| convert_to_notion_task / add_to_calendar 只 mark_done（误导）| LLM (`task_extractor`) 决策 → 真建日程库 task / 会议 + Email Inbox relation |
| escalate_to_oncall / ack_in_pagerduty（运维场景）| 已下线（产品经理用户不用）|
| open 类只开系统 Mail.app / Notion | gate on → mailagent:// deeplink 打开前端对应邮件（F6）|

**下个 session 三选一主线**（详见 §4）：① dogfood 巩固 + 翻 flag；② Phase 3 DailyDigest（每日巡检）；③ archive_and_unsubscribe 真退订。

---

## 1. 这轮 ship 的（commit 时序，`feat/agent-harness`）

**Phase 2 — AI 动态建议按钮**（替代静态 5 按钮）：
- `02f0e5f` T2.1 LLM schema recommended_actions + prompts
- `5877fd8` T2.2 sanitize + dynamic intervention.options
- `7f9e066` T2.3 island_response 17→现 15 handler
- `7b36b43` T2.6 handoff
- fork `bbcf85a`（button respondToIntervention wire）/ `c10973c`（detail 二行渲染）

**F1-F6 — 按钮真实化 + open 改前端**：
- `d18619f` F1 `mailagent email draft` CLI + 修 Phase 1 `--api-key` 后置 bug
- `0ba4285` F2 escalate_to_oncall 下线
- `a1649f8` F3 convert_to_notion_task 真建日程（LLM 决策）
- `3b842d1` ⭐ email draft 改从 **SQLite SSoT** 读 reply_suggestion（不读 Notion — 含用户改过的）
- `d64f4da` F4 ack_in_pagerduty 下线
- `6c9c32b` F5 add_to_calendar 真建日程（LLM 抽会议时间，`--as-meeting`）
- `3acc044` F6 open 类 `mailagent://` deeplink（前端 main scheme + renderer 路由 + plugin gate）
- `9fbb5d4` CLAUDE.md 同步 / `94c15a5` 修 3 个预存前端测试失败

**测试**：plugin `tests/llm_agent` + `tests/notify` 全 pass；CLI `tests/cli/test_email_draft` + `test_notion_create_task` 全 pass；前端 `deeplink.test` 16 pass + typecheck pass。

---

## 2. 灵动岛 15 个 action 最终 wire（`src/notify/island_response.py`）

| action | 真效果 | handler |
|---|---|---|
| create_draft / quick_reply_yes / quick_reply_no_with_reason / decline_with_reason / nudge_recipient | `mailagent email draft <id>` → SQLite reply_suggestion → backend.append_draft | `_create_draft` |
| mark_done / archive_only / archive_and_unsubscribe / mark_done_no_response | `mailagent notion update-flag → 已完成` | `_mark_done` (alias) |
| convert_to_notion_task | `mailagent notion create-task` LLM 决策建日程 task | `_convert_to_notion_task` |
| add_to_calendar | `mailagent notion create-task --as-meeting` LLM 抽会议时间 | `_add_to_calendar` |
| open_notion | gate on → `mailagent://email/<id>` 前端；off → Notion | `_open_notion` |
| open_mail | gate on → `mailagent://email/<id>` 前端；off → 系统 Mail.app | `_open_mail` |
| snooze_1h / defer_to_monday_9am | island_snooze 入队（后者算到下个工作日 9am）| `_enqueue_snooze` |

**已下线**：escalate_to_oncall / ack_in_pagerduty（schema + prompt + handler + test 四处一致移除）。

LLM recommended_actions whitelist 现 10 个（8 inbox + 2 sent），见 `src/llm_agent/schema.py:RECOMMENDED_ACTION_ID_*`。

---

## 3. dogfood 清单（ship 后必跑）

**前置**：本机已配 `MAILAGENT_CLI_API_KEY`、`PING_ISLAND_ENABLED=true`、LLM 相关 env。

**A. plugin 侧（F1-F5，pm2 restart 即可测）**：
```bash
pm2 restart mail-sync   # 加载新 island_response + task_extractor

# 单测各 CLI（不依赖灵动岛点击）
KEY=$(grep "^MAILAGENT_CLI_API_KEY=" .env | cut -d= -f2-)
mailagent email draft <有 reply_suggestion 的 id> --dry-run -o json    # 看 reply_source=sqlite
mailagent notion create-task <id> --dry-run -o json                    # 看 LLM task fields
mailagent notion create-task <会议邮件 id> --as-meeting --dry-run -o json  # 看 💼工作·会议

# 真灵动岛点击：真邮件 → 点"快速回复"/"转 Notion 任务"/"加入日历" → 看 pm2 logs mail-sync
#   应见 [island-response] choice=... + CLI 真跑（草稿/日程 page 真建）
```
> 找有 reply_suggestion 的邮件：`sqlite3 data/sync_store.db "SELECT internal_id FROM llm_processing WHERE COALESCE(json_extract(labels_json,'\$.reply_suggestion_md'),'')!='' LIMIT 3"`

**B. F6 deeplink（需打包，dev 模式 scheme 受限）**：
```bash
cd frontend && pnpm build:mac          # 打包 .app（自带 rebuild:electron + 注册 mailagent:// scheme）
# 装 .app 到 /Applications → 系统注册 scheme
echo 'MAILAGENT_FRONTEND_DEEPLINK_ENABLED=true' >> .env   # ⚠️ 当前 .env 还没这行
pm2 restart mail-sync
# 灵动岛点 open_mail → 应唤起 MailAgent 前端 + 聚焦该邮件（setActive + navigate('/')）
```

**注意**：前端 vitest 必须 `pnpm test`（自带 `rebuild:node` 修 better-sqlite3 node ABI），**不要** `npx vitest run`（会 99 个 ERR_DLOPEN_FAILED）。

---

## 4. 下一步高优先级（下个 session 选主线）

### P0 — dogfood 巩固 + 收口（推荐先做）
Phase 2 + F1-F6 都在 `feat/agent-harness`，**还没真邮件 dogfood 过**。建议先按 §3 跑一轮真验证，发现 bug 先修，再考虑翻 default flag / 合 main。这是把已 ship 工作落地的关键，比堆新功能优先。

### P1 — Phase 3：每日跨邮件巡检 DailyDigest（PRD §5.3，~2d）
PRD 路线的下一个大功能，用户能直接感知：
- 新 `src/notify/island_digest.py`：查最近 24h 邮件 → LLM 跑一次 cross-email summary（输入每封 11 AI 字段 + subject）→ 输出 1 段话 + 3-5 个 **bulk action**（"全归档 5 封 newsletter" / "批量标完成"）
- `main.py` asyncio scheduled task（9:00 / 18:00）或 launchctl cron
- 新 envelope eventType `DailyDigest` + `dispatch_daily_digest()`
- fork 新 scene `MailAgentDigestView.swift`（标题"今日总结" + counts + bulk action）
- bulk handler 复用 island_response（archive_batch / mark_done_batch）
- DND 检测（开了 DND 跳过；不在桌前等首次活跃再推）
- flag `MAILAGENT_DAILY_DIGEST_ENABLED`

### P2 — backlog（按价值排）
1. **archive_and_unsubscribe 真退订**（高频 newsletter）：当前只 mark_done（`_log_alias_intent` 标了 TODO）。真做需抽邮件 `List-Unsubscribe` header → 自动 open unsubscribe URL / one-click POST。
2. **Phase 4 智能 snooze**（PRD §5.4，~1-2d）：defer_to_monday_9am 已有 `_seconds_until_next_monday_9am` 雏形；完整版 = 项目周报→周一9am / 会议邀请→会议前30min / 紧急→1h，envelope 加 `recommendedSnoozeAt` + `snoozeReason`，LLM 在分类时一次性出。flag `MAILAGENT_SMART_SNOOZE_ENABLED`。
3. **F6 deeplink e2e 真验证**（打包后真点 mailagent://，确认前端聚焦邮件）。

### P3 — 测试债（非阻塞）
前端 vitest 全套 71-file 并发时 `CommandPalette`（fake timers）+ `useEmailChat` done-event 偶发 **flaky**（单独/小批跑 pass）。预存 `fileParallelism` 时序问题，非灵动岛引入。修法：vitest config `isolate` / `fileParallelism: false`，或逐个修 async 时序。

---

## 5. 关键文件 / 模块速查

**plugin（mail-sync 进程内）**：
- `src/notify/island_dispatch.py` — 9 事件 → envelope；`dispatch_llm_reviewed(recommended_actions=)` 动态注入
- `src/notify/island_response.py` — 15 action handler（`_create_draft` / `_convert_to_notion_task` / `_add_to_calendar` / `_open_mail` deeplink gate / `_mailagent_args` api-key 前置）
- `src/notify/island_action_whitelist.py` — KNOWN_ACTION_IDS（static 5 + recommended 10）
- `src/notify/island_snooze.py` — snooze 队列（Phase 4 智能 snooze 扩这里）
- `src/llm_agent/task_extractor.py` — 邮件 → 日程库 task fields（as_meeting 模式）
- `src/llm_agent/schema.py` — `RECOMMENDED_ACTION_ID_INBOX/SENT`（动态建议 whitelist）

**CLI**：
- `src/cli/commands/email.py:email_draft` — F1 草稿 CLI（SQLite reply_suggestion）
- `src/cli/commands/notion.py:notion_create_task` — F3/F5 建日程 CLI（`--as-meeting`）

**前端**：
- `frontend/src/electron/main/deeplink.ts` — mailagent:// 解析 + cold-start buffer
- `frontend/src/electron/main/index.ts` — scheme 注册 + open-url + second-instance + sink
- `frontend/src/shared/router-instance.tsx:useDeeplinkRouter` — renderer deeplink 路由
- `frontend/electron-builder.yml:protocols` — 打包 scheme 声明

**fork**（`~/Documents/ping-island/`，branch `feat/mail-brand`）：
- `PingIsland/UI/Views/MailAgentSessionView.swift` — 6 scenario layout + interventionButton（detail 二行 + respondToIntervention wire）

---

## 6. 下个 session 启动 prompt

把下面整段粘贴到新 session（推荐 Opus 4.7 1M context）：

```
ultrathink 继续 MailAgent 灵动岛 Ping Island 工作。

Phase 1 + Phase 2 + F1-F6（按钮真实化）已全部 ship 到 feat/agent-harness（2026-05-26）。
灵动岛按钮从"好看但假"做到"真触发业务"：create_draft 走 SQLite reply_suggestion 真起草、
convert_to_notion_task / add_to_calendar LLM 决策真建日程、open 类 mailagent:// deeplink
打开前端、escalate/ack 运维 action 下线。

开始前先读这 2 个文件（按顺序）：
1. /Users/chenyuanquan/Documents/MailAgent/frontend/ISLAND-F1-F6-HANDOFF.md（本 handoff，含 ship 状态 + action 表 + dogfood 清单 + 优先级 backlog）
2. memory: project_mailagent_ping_island_prd.md（4 phase 路线 + 非目标）

跟我确认主线后再动手，三选一：
- A（推荐）：先 dogfood 巩固 — 按 handoff §3 真邮件验证 F1-F6 + Phase 2，发现 bug 先修，
  再考虑翻 default flag。把已 ship 工作落地优先于堆新功能。
- B：Phase 3 DailyDigest — 每日 9:00/18:00 跨邮件巡检 push（新 island_digest.py +
  cron + DailyDigest eventType + fork digest scene + bulk action）。PRD §5.3，~2d。
- C：archive_and_unsubscribe 真退订 — 当前只 mark_done，真做抽 List-Unsubscribe header
  自动退订（高频 newsletter 场景）。

约束（PRD 非目标，不要碰）：灵动岛不做 AI 多轮对话 / textarea / tool_use 跨域；
fork minimal < 800 行 diff 月度 rebase 友好；写操作必须用户在灵动岛 confirm click。

每个独立任务完一个 atomic commit。涉及 fork 改动在 ~/Documents/ping-island branch=feat/mail-brand。
前端测试用 pnpm test（自带 rebuild:node），不要 npx vitest run。
```

---

**作者**：Claude Opus 4.7 (1M context)，代表 chenyqthu
**日期**：F1-F6 ship 完工 2026-05-26
