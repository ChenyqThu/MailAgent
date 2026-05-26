# Phase 2 · AI 动态建议按钮 Handoff

> **状态**：✅ **Phase 2 实施完工 2026-05-26**（4 commits, 3 主仓 + 1 fork）。`MAILAGENT_AI_DYNAMIC_ACTIONS=true` flag 未引入 — 代码路径已 wire (LLM 留空数组时自动 fallback 静态 5), 无需新 flag. T2.6 dogfood ≥ 2d 留给 user 真邮件触发验证, 同时一起验证 T7 Scene 1/2/4. 本 handoff 仍保留作 Phase 3 接力前的整体 Phase 2 设计 + 决策记忆.
>
> **Ship commit (按时序)**:
> - `02f0e5f` — T2.1 LLM schema + prompts (recommended_actions field, 10 inbox + 2 sent whitelist enum)
> - `5877fd8` — T2.2 sanitize + envelope dynamic options (whitelist module + processor sanitize + dispatch _build_dynamic_options)
> - `7f9e066` — T2.3 island_response 17 handler 全覆盖 (mark_done 5 alias + create_draft 4 alias + add_to_calendar + defer_to_monday_9am + ack_in_pagerduty + Phase 1 静态 5 路径不变)
> - fork `c10973c` — T2.5 fork detail 二行渲染 + 高度 30→44 + T2.4 docstring 收尾
> - **T2.4 主体早在 fork `bbcf85a` (2026-05-25) 已 ship** (button click 真触发 plugin handler), Phase 2 起 dispatch 端能拿到 dynamic options 真用上.
>
> **测试**: 221 pass tests/llm_agent + tests/notify (Phase 1 现有 + Phase 2 新 +49: schema 9 + whitelist 11 + dispatch dynamic 16 + processor sanitize 13). 0 regression.
>
> **关联**：
> - PRD: `~/.claude/plans/ultrathink-session-curious-cloud.md` §5.2 Phase 2
> - Memory: `~/.claude/projects/-Users-chenyuanquan-Documents-MailAgent/memory/project_mailagent_ping_island_prd.md`
> - Phase 1 T3 路由决策: `frontend/PHASE-1-T3-ROUTING-DECISION.md` + fork 内 `docs/mailagent/PHASE-1-T3-ROUTING-DECISION.md`
> - Mascot 规格: `frontend/MASCOT-SPEC.md`
> - Mockup: `frontend/mockup-dynamic-island.html` v4 §2 Scene 3

---

## 0. TL;DR

| 维度 | 决策 |
|---|---|
| **目标** | 替代当前 5 个静态 intervention 按钮（create_draft / open_mail / open_notion / mark_done / snooze_1h），让 LLM 根据邮件内容动态生成 1-3 个**针对性**建议 |
| **不做** | AI 对话 / tool_use / 实时调 LLM（PRD §2.2 非目标坚守）|
| **工作量** | ~2-3d 一个 session 内可完成（Python 为主，Swift 仅 detail 字段渲染微调）|
| **核心改动面** | LLM schema 扩展 + prompts 升级 + envelope 动态注入 + 7-8 个新 action handler + button real action wire（Phase 1·T4 留的 TODO）|
| **关键非妥协** | LLM cost 增加 ≤ 10%（复用同一次调用 + cache hit）；confidence < 0.5 → 退回静态 5 按钮 fallback |

---

## 1. 立即上下文（5 分钟读完）

### 1.1 Phase 1 已 ship 状态

**MailAgent 主仓 `feat/agent-harness`**（4 commits）：
- `09c7b66` T1+T2 envelope schema (aiSummary/scenario/mascot/senderDigest) + mascot domain 规则
- `996b42b` T3 路由决策 memo mirror
- `8273101` T6 mascot 出图规格 mirror
- `d7d2e21` ⭐ **T7 brand 推导 bug fix** — `_base_metadata` 加 `client_kind/client_name/client_origin/client_originator/thread_source` 5 个 fork makeClientInfo 期待的 key

**ping-island fork `feat/mail-brand`**（6 commits, fork upstream `erha19/ping-island`）：
- `63a2117` T3 路由决策 memo
- `df9314e` T4 Swift wire — MailAgentSessionView 6 scenario layout + HookEvent.metadata + SessionState.hookMetadata + 2 接入点 (SessionAttentionNotificationView / SessionHoverDashboardView)
- `d084dbb` T4 button minimal wire — `interventionResolved` view dismiss (no-op for plugin action)
- `004626b` T6 MASCOT-SPEC
- `0e5c8b2` T6 真 pixel-art PNG ship — 4 imageset × 3 档 = 12 PNG + MailAgentSessionView 切到 Image() 真 imageset
- `171f907` ⭐ **T7 brand 推导 bug fix** — runtimeProfiles 加 mailagent entry (brand=.mail)

### 1.2 数据流（端到端打通）

```
mail-sync (Python)
  ↓ LLM 处理 → AILabels (ai_summary / priority / action / ...)
  ↓
src/notify/island_dispatch.py::dispatch_llm_reviewed
  ↓ envelope.metadata 含 client_kind="mailagent" + mailagent.*
  ↓ envelope.intervention.options = 5 个静态选项
  ↓
Unix socket /tmp/island.sock
  ↓
ping-island (Swift) HookSocketServer.makeClientInfo
  ↓ matchRuntimeProfile 用 client_kind 匹配 runtimeProfiles → profileID=mailagent
  ↓ brand=.mail
  ↓
SessionStore.processHookEvent → session.intervention = event.intervention(question kind)
  ↓ session.hookMetadata = event.metadata (全 mailagent.* keys)
  ↓ session.phase = .waitingForInput
  ↓ needsAttention = true
  ↓
IslandExpandedRouteResolver → .attentionNotification(session)
  ↓
SessionAttentionNotificationView body:
  if session.clientInfo.brand == .mail {
      MailAgentSessionView(...)   ← 走我们的路径
  } else {
      HoverSessionCard(...)        ← generic 兜底
  }
  ↓
MailAgentSessionView.attentionLayout (scenario=LLMReviewedUrgent):
  - mascot (Image("MailMascotWork") 真 pixel-art)
  - eyebrow (MailAgent · 工作邮箱)
  - title (subject)
  - sender line (from: ...)
  - aiSummary
  - chipsRow (priority + action chips)
  - interventionButtonRow (loop session.intervention.options, 渲染 button)
```

### 1.3 当前 button 行为（Phase 2 主改点）

`MailAgentSessionView.interventionButton` onTap 当前：
```swift
Task {
    await SessionStore.shared.process(
        .interventionResolved(
            sessionId: sessionId,
            nextPhase: .ended,
            submittedAnswers: [optionId: ["1"]]
        )
    )
    await MainActor.run { onActionCompleted() }
}
```

**问题**：只让 view dismiss，**没真触发 plugin 端 action**。用户点 "打开 Mail.app" 不会真打开 Mail.app；点"稍后再看"不会真 snooze。

**Phase 2 修复**：通过 `HookSocketServer.shared.respondToIntervention` 反向发回 socket，plugin 端 `ping_island.send_async` 等到 response → `island_response.handle_response(option_id)` → 调对应 action handler（osascript / mailagent CLI / Notion API）。

### 1.4 T7 dogfood 状态

- ✅ Scene 3 (LLMReviewedUrgent) 手测对照 mockup §2 一致 — Postman mascot + 完整字段 + button 视觉
- ⏸ Scene 1 (Mixed monitor row) — 待真邮件 sync 验证
- ⏸ Scene 2 (AIDraftReady DRAFT REPLY card) — 待 AI draft pipeline 触发
- ⏸ Scene 4 (MailCompleted 绿副标) — 待 Notion completion 触发
- ⏸ fail-open — 待 quit ping-island 后看 mail-sync 不卡

**Phase 2 开始前**：先跟 user 确认 T7 是否有 dogfood 反馈需要先修。如果有，先修复再进 Phase 2。

---

## 2. Phase 2 范围

### 2.1 目标

替代 5 个静态 intervention button → AI 根据邮件内容动态生成 1-3 个针对性 button。

**典型场景**：

| 邮件类型 | 当前 5 静态 button | Phase 2 AI 动态 button（示例）|
|---|---|---|
| Newsletter (`Stripe Weekly Update`) | create_draft / open_mail / open_notion / mark_done / snooze_1h | **archive_and_unsubscribe** / **archive_only** / mark_done |
| 项目周报 (xlsx attachment) | 同上 | **defer_to_monday_9am** / open_mail / convert_to_notion_task |
| 会议邀请 (.ics) | 同上 | **add_to_calendar** / **decline_with_reason** / snooze_until_meeting_minus_30min |
| 紧急告警 (PagerDuty) | 同上 | **ack_in_pagerduty** / **escalate_to_oncall** / open_mail |
| 询问邮件 ("能否参加 review?") | 同上 | **quick_reply_yes** / **quick_reply_no_with_reason** / open_mail |

### 2.2 不做（守住 PRD §2.2 非目标）

- ❌ AI 多轮对话 / textarea / 流式（V1 Electron AI Chat panel 承担）
- ❌ tool_use 跨域查询
- ❌ AI 自动发送/自动归档（一切 write 操作必须用户在灵动岛 confirm click）
- ❌ 高危 action AI 自动推（delete / send_email_immediately 禁止 AI 推）

---

## 3. 任务拆分（建议在 session 开始用 TaskCreate 列出来）

### T2.1 LLM schema + prompts 升级（~3-4h Python）

**改动文件**：
- `src/llm_agent/schema.py` — `EMAIL_TOOL_SCHEMA["input_schema"]["properties"]` 加 `recommended_actions` field：
  ```python
  "recommended_actions": {
      "type": "array",
      "maxItems": 3,
      "items": {
          "type": "object",
          "additionalProperties": False,
          "required": ["id", "title", "confidence"],
          "properties": {
              "id": {"type": "string", "enum": [...]},   # whitelist 见 §4
              "title": {"type": "string", "maxLength": 30},
              "detail": {"type": "string", "maxLength": 80},
              "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0}
          }
      },
      "description": "1-3 个针对性处理建议..."
  }
  ```
- `prompts/email_inbox.md` — 加段（参考现有 11 字段 prompt 风格）：
  ```markdown
  ## 📋 推荐处理动作 (recommended_actions)
  
  根据邮件内容,生成 1-3 个最相关的处理建议. 优先 fixed action whitelist:
  - newsletter / 营销邮件 → archive_and_unsubscribe (高 confidence) + archive_only
  - 会议邀请 → add_to_calendar + decline_with_reason
  - 项目周报 → defer_to_monday_9am + convert_to_notion_task
  - 紧急告警 → ack_in_pagerduty + open_mail
  - 询问邮件 → quick_reply_yes + quick_reply_no_with_reason
  - 普通邮件 → 退回静态 5 按钮 (confidence < 0.5, 不填本字段)
  
  title 简洁 (≤ 30 char, 中文优先), detail 解释推荐理由 (≤ 80 char).
  ```
- `prompts/email_sent.md` — 类似段加发件箱 follow-up action：`mark_done_no_response` / `nudge_recipient`

**预期 LLM cost 变化**：≤ 10%（complete-payload 复用同一次调用，prompt cache 命中率不破）。监控 `mailagent llm stats --days 1` 确认。

**T2.1 验收**：
- `pytest tests/llm_agent/test_schema.py -v` 全 pass
- `mailagent llm run <internal_id> --dry-run` 输出含 `recommended_actions` 字段（4 种典型邮件类型各跑一次）

### T2.2 action whitelist + envelope 动态注入（~2-3h Python）

**新文件**：`src/notify/island_action_whitelist.py`
- 定义 `KNOWN_ACTION_IDS: set[str]` 含全部允许的 action id（约 8-12 个）
- 每个 action id 含 `default_title` / `default_detail` / `handler_name`（i18n fallback 用）
- LLM 输出 id 不在白名单 → drop（防 AI 创造未支持的 action）

**改动文件**：
- `src/notify/island_dispatch.py::dispatch_llm_reviewed`：
  - 接收新参数 `recommended_actions: Optional[List[Dict]] = None`
  - urgent 分支内：
    ```python
    if recommended_actions:
        filtered = [a for a in recommended_actions 
                    if a.get("id") in KNOWN_ACTION_IDS 
                    and a.get("confidence", 0) >= 0.5]
        if filtered:
            intervention = Intervention(
                title=title, message=message,
                options=[InterventionOption(
                    id=a["id"],
                    title=a.get("title") or i18n.t(f"mail.action.{a['id']}"),
                    detail=a.get("detail"),
                ) for a in filtered[:3]],  # cap 3
            )
        else:
            # fallback 静态 5 按钮 (现有逻辑)
            intervention = Intervention(...DEFAULT_OPTION_IDS...)
    ```
- `src/mail/new_watcher.py::_maybe_dispatch_island_reviewed` — 透传 `labels.get("recommended_actions")` 给 dispatch_llm_reviewed

**T2.2 验收**：
- 23 个现有单测不破
- 新加 5+ 单测：
  - LLM 出 1 action / 2 actions / 3 actions / >3 actions (cap 3)
  - LLM 出 unknown action id → drop
  - LLM 出 confidence < 0.5 → 退回静态 5 按钮
  - LLM 字段缺失 → 退回静态 5 按钮

### T2.3 action handler 扩展（~3-4h Python）

**改动文件**：`src/notify/island_response.py`
- 现有 5 个 handler (create_draft / open_mail / open_notion / mark_done / snooze_1h)
- 新增 6-8 个 handler，按业务 wire：

| Action id | Handler 调用路径 |
|---|---|
| `archive_and_unsubscribe` | `mailagent notion update-flag --processing-status 已完成` + 自动复制 unsubscribe URL（如果邮件含）|
| `archive_only` | `mailagent notion update-flag --processing-status 已完成` |
| `add_to_calendar` | parse .ics → osascript → Calendar.app new event；或 mailagent calendar create-event |
| `decline_with_reason` | `mailagent email draft --internal-id N --template decline_with_reason` |
| `defer_to_monday_9am` | snooze 升级（Phase 4 智能 snooze 雏形，但本 phase 简化）|
| `convert_to_notion_task` | Notion API create_task in linked 项目库 |
| `ack_in_pagerduty` | open `https://acme.pagerduty.com/incidents/X`（PagerDuty 邮件含 link）|
| `quick_reply_yes` / `quick_reply_no_with_reason` | mailagent email draft 加 template |

**注意**：高危 action（delete / send_email_immediately）**不要**在白名单内，永远要求用户手动。

**T2.3 验收**：
- 每个新 handler 至少 1 个单测（mock subprocess / osascript）
- end-to-end smoke test：手测 nc 发 envelope 含 archive_only → 看 mail-sync log 是否真触发 mailagent notion update-flag

### T2.4 button real action wire（~2h Swift + Python）

**问题**：Phase 1·T4 留的 TODO — button click 当前只本地 view dismiss，没发 response 回 plugin。

**Fork 端改动**（`MailAgentSessionView.swift::interventionButton`）：
```swift
Button {
    let sessionId = session.sessionId
    let optionId = opt.id
    Task {
        // 1. 向 plugin 发 response (新加)
        HookSocketServer.shared.respondToIntervention(
            toolUseId: session.intervention?.id ?? sessionId,
            decision: optionId,  // 这是 plugin _extract_choice 期待的 string
            updatedInput: nil
        )
        // 2. 本地 view dismiss (现有)
        await SessionStore.shared.process(
            .interventionResolved(...)
        )
        await MainActor.run { onActionCompleted() }
    }
}
```

**Plugin 端验证**（`src/notify/dispatch.py::_fire` 内的 `_bg` 函数）：
- 现有路径 `result = await ping_island.send_async(envelope)` 已经 await response
- response 到达后 `_extract_choice(result.response)` 提取 option id
- 然后 `await island_response.handle_response(result.response, envelope.metadata)` 调对应 handler

**关键确认**：测试 fork respondToIntervention API 真把 string decision 写回 socket（看 HookSocketServer line 1818+ 的 socket response 路径）。可能需要适配 plugin `_extract_choice` 期待的 `{"decision": {"answer": {"choice": "..."}}}` JSON shape。

**T2.4 验收**：
- nc 手测 envelope → 用户在灵动岛点 archive_only button → 看 mail-sync log 真触发 mailagent notion update-flag
- 真邮件 dogfood 触发 archive_and_unsubscribe → 看 Notion 真标完成

### T2.5 fork MailAgentSessionView 渲染 option.detail（~1h Swift）

**当前问题**：`SessionInterventionOption` 已含 `detail: String?` 字段，但 `MailAgentSessionView.interventionButton` 只渲染 `opt.title`，detail 没显示。

**改动**：button 高度从 30 → 44，加上 second line 显示 detail（Stripe Weekly Update → button title "归档并退订" + detail "已订阅 6 个月，每周一封"）。

参考 mockup §2 Scene 3 button 的 detail 渲染（如果有）或者 Apple Notification action style。

**T2.5 验收**：
- fork rebuild + 手测 nc envelope 含 detail 字段 → 灵动岛 button 显示 title + detail 二行

### T2.6 PR 整理 + 测试 + dogfood（~2h）

- 跑全单测 `pytest tests/notify/ tests/llm_agent/ -v`
- `mailagent llm run` 测 4-5 种真邮件，看 recommended_actions 输出合理
- 翻新 envelope JSON 含 recommended_actions 喂 ping-island 视觉验证
- 真邮件 dogfood ≥ 2 天
- commits ship 后 update `frontend/PHASE-2-AI-SUGGESTIONS-HANDOFF.md` 末尾的"完成情况"段（本文档 §6）
- 触发 Phase 3 (Daily Digest) handoff 撰写

---

## 4. Action whitelist 完整草案（T2.2 实施时复制粘贴）

```python
# src/notify/island_action_whitelist.py
"""Phase 2 — AI 动态建议 action whitelist + i18n fallback."""

KNOWN_ACTION_IDS: set[str] = {
    # Newsletter / 营销
    "archive_and_unsubscribe",
    "archive_only",
    # 会议邀请
    "add_to_calendar",
    "decline_with_reason",
    # 项目周报
    "defer_to_monday_9am",
    "convert_to_notion_task",
    # 紧急告警
    "ack_in_pagerduty",
    "escalate_to_oncall",
    # 询问邮件
    "quick_reply_yes",
    "quick_reply_no_with_reason",
    # Phase 1 静态兜底 (保留兼容)
    "create_draft",
    "open_mail",
    "open_notion",
    "mark_done",
    "snooze_1h",
}

# 默认 title/detail (用户 prompt 不指定 title 时 fallback)
ACTION_DEFAULTS: dict[str, dict[str, str]] = {
    "archive_and_unsubscribe": {
        "title": "归档并退订",
        "detail_template": "已订阅 {sub_months} 个月, 每周/月一封",
    },
    "archive_only": {
        "title": "归档",
        "detail_template": "标完成不再提醒",
    },
    # ... 其他 action id 类似
}
```

**关键约束**：
- LLM 出 unknown id → silent drop（不要让 AI 创造未支持的 action）
- LLM 出高危 id（delete / send / etc）→ 不应该出现在 whitelist
- 用户在灵动岛 click whitelisted action → 走对应 handler

---

## 5. 风险 + 缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| LLM 出建议跟人感觉离谱 | 高 | confidence < 0.5 → fallback 静态 5 按钮；用户调研驱动 prompt 迭代；ABT 跟踪 click-through 率 |
| LLM 字段加进 schema 破现有 prompt cache | 中 | 把 `recommended_actions` 加在 properties 末尾（不影响 prefix hash 稳定性）；监控 cache_hit_rate_pct（应不掉）|
| LLM cost > 10% 涨幅 | 中 | 同一次调用复用（不发额外 LLM 请求）；监控 `mailagent llm stats --days 7` |
| Action handler 写错误业务（如 archive 真物理删邮件）| 高 | 全部 handler **必须**走现有 mailagent CLI / Notion API，不直调 AppleScript 邮件操作；review 时强制 |
| fork HookSocketServer.respondToIntervention 路径跟 plugin _extract_choice JSON shape 不匹配 | 中 | T2.4 实施时先看 plugin `_extract_choice` 期待 `{"decision":{"answer":{"choice":...}}}` 然后对照 fork 端 API |
| 用户点 button 真触发 action 慢 / 失败 → 灵动岛 hang | 中 | plugin `ping_island.send_async` 现有 3s timeout fail-open；fork 端 view dismiss 独立 action handler，不互相阻塞 |

---

## 6. Phase 2 完成情况

| Task | Status | Commit | 关键改动 |
|---|---|---|---|
| T2.1 LLM schema + prompts | ✅ | main `02f0e5f` | `EMAIL_TOOL_SCHEMA.recommended_actions` (maxItems=3, items=`{id,title,detail,confidence}`) + `RECOMMENDED_ACTION_ID_INBOX/SENT` 12 id whitelist + `is_valid_recommended_action_id` helper. prompts/email_inbox.md + email_sent.md 末尾加 "Recommended Actions" 段含 whitelist table + 决策示例 4 类典型邮件 |
| T2.2 action whitelist + envelope 动态注入 | ✅ | main `5877fd8` | 新 `src/notify/island_action_whitelist.py` (STATIC_FALLBACK 5 + RECOMMENDED 12 + KNOWN 17 frozenset + helpers). `processor._parse` sanitize (mailbox-specific whitelist + shape + length 30/80 + confidence clamp [0,1] + NaN guard + cap 3). `AILabels.recommended_actions` + `summary_for_log.ai_summary_full`. `dispatch_llm_reviewed(recommended_actions=...)` + `_build_dynamic_options` (confidence >= 0.5 + handler whitelist + cap 3 二层防御). new_watcher 透传 `labels.get("recommended_actions")` |
| T2.3 action handler 扩展 | ✅ | main `7f9e066` | `island_response.handle_response` 加 12 个新 choice 分支. mark_done aliases 5 (archive_only / archive_and_unsubscribe / mark_done_no_response / convert_to_notion_task / escalate_to_oncall) + create_draft aliases 4 (decline_with_reason / quick_reply_yes / quick_reply_no_with_reason / nudge_recipient) + 独立 3 (add_to_calendar 拉起 Calendar.app, defer_to_monday_9am 算到下一个工作日 9 点 snooze, ack_in_pagerduty open URL 含 http/https 白名单防 xss). +38 test (含 _seconds_until_next_monday_9am 6 个边界单元) |
| T2.4 button real action wire | ✅ | fork `bbcf85a` (Phase 1·T7 follow-up 早 ship) + fork `c10973c` docstring 收尾 | `MailAgentSessionView.interventionButton` onTap 调 `HookSocketServer.shared.respondToIntervention(toolUseId:, decision:"answer", updatedInput:["choice": opt.id])` 写 BridgeResponse JSON 回 plugin. toolUseId 来自 `session.hookMetadata["tool_use_id"]` (plugin envelope.py `to_wire_dict` 自动注入 `bridge-<envelope_id>`), fallback sessionId 兜底. Plugin 端 `_extract_choice` → `island_response.handle_response` → 触发 17 handler. T2.5 收尾时清掉过时 docstring |
| T2.5 fork detail 字段渲染 | ✅ | fork `c10973c` | `interventionButton` label 从 `HStack { Text(title) }` 改 `VStack(alignment: .leading, spacing: 2) { Text(title) + if hasDetail Text(detail) }`. frame 高度 30 → minHeight 44 (Apple Notification action style). title font 12pt semibold lineLimit 1, detail font 10pt regular 55% opacity lineLimit 1. detail 空时 row 仍 44 单行垂直居中保 row 一致. xcodebuild -scheme PingIsland 通过 |
| T2.6 测试 + dogfood ≥ 2d + handoff 收尾 | 🔄 | main `<本次>` 部分 — code + doc ship; dogfood 留 user | 全套 221 tests pass tests/llm_agent + tests/notify (0 regression). handoff §0 + §6 update. dogfood 步骤: PM2 restart mail-sync → 真邮件 sync → 看 LLM 出 recommended_actions (`mailagent llm run <id> --dry-run -o json | jq .recommended_actions`) → 真灵动岛 click button 验证 17 个 handler 之一真触发 |

---

## Phase 2 主要收获 (写给 Phase 3 实施 session)

1. **Schema 加新字段不破 prefix cache 假设过乐观** — handoff §5 风险表说 "加在 properties 末尾不影响 prefix hash 稳定性" 是误解. Anthropic prompt cache 用 prefix bytes hash, tools 块在 system 之前; 改 schema 必然一次性 cache miss. 但只 miss 一次后新 prefix 稳定下来, 后续命中正常. ship 前看 `mailagent llm stats --days 1` cache_hit_rate 短期下降是预期.

2. **AILabels.summary_for_log 同时承担 log line 和 dispatch carrier 两职责** — Phase 1 一直 silent 截 80 给 envelope, 此次 T2.2 暴露 `ai_summary_full` 字段才修. Phase 3 加新字段时直接添加到 AILabels + summary_for_log + dispatch 链路, **不再走截短副本**.

3. **Phase 1 T2.4 button wire 早在 `bbcf85a` ship, handoff 落后于代码** — 我们以为 button click 还是 no-op, 实际看 fork `git log` 才知道已 ship. **下次开 Phase 3 前先跑 `cd ~/Documents/ping-island && git log --oneline -20` 看 fork 端有没有意外进展**.

4. **17 个 handler 中 6 个是 "TODO Phase 3 业务跟进" alias** (archive_and_unsubscribe 抽 List-Unsubscribe header / convert_to_notion_task 调 Notion API / escalate_to_oncall 发飞书 / add_to_calendar 真 .ics parse / defer_to_monday_9am 升级 / ack_in_pagerduty 完整 URL 抽取). Phase 3 可优先做高 ROI 的 (archive_and_unsubscribe 实际邮件占比最大).

5. **fork minimal 原则保持** — Phase 2 fork 端只改 1 文件 33 行 (MailAgentSessionView.swift), upstream rebase 友好.

6. **测试 ROI**: pytest 221 个全 pass 给的信心 vs fork SwiftUI xcodebuild **BUILD SUCCEEDED** 一次给的信心相当. Phase 3 写新 view 时 fork 端先 swiftc -parse 单文件再 xcodebuild full build 两步走

---

## 7. 下一次 session: Phase 3 (Daily Digest) 启动 prompt

把下面的内容**完整粘贴**到新 session：

```
ultrathink 继续 MailAgent 灵动岛 Phase 3 实施。

Phase 1 + Phase 2 已 ship 完工 (跨 MailAgent 主仓 + ping-island fork). Phase 2
LLM 已能根据邮件内容动态出 1-3 个按钮 (recommended_actions), 替代静态 5 fallback;
fork 端 button click 真触发 17 个 handler 中之一 (mark_done aliases 5 / create_draft
aliases 4 / 独立 3 + 静态 5).

现进 Phase 3: 每日 9:00/18:00 跨邮件巡检 push (新 eventType DailyDigest).
LLM 跑一次 cross-email summary (输入: 每封邮件的 11 AI 字段 + subject), 输出
1 段话 + 3-5 个 bulk action ("全归档 5 封 newsletter" / "批量标已完成").

任务开始前先读这 4 个文件:
1. /Users/chenyuanquan/Documents/MailAgent/frontend/PHASE-2-AI-SUGGESTIONS-HANDOFF.md (Phase 2 ship 总结 + 主要收获)
2. /Users/chenyuanquan/.claude/plans/ultrathink-session-curious-cloud.md §5.3 (PRD Phase 3 完整 scope)
3. memory: project_mailagent_ping_island_prd.md (整体决策记忆)
4. fork ~/Documents/ping-island/ branch=feat/mail-brand `git log --oneline -10` (fork 现状)

Phase 3 任务大致 (PRD §5.3 6 步):
- 新 src/notify/island_digest.py — 跨邮件 LLM summary + bulk action 生成
- main.py / cron asyncio scheduled task (9:00 / 18:00)
- 新 envelope eventType=DailyDigest + intervention.options 含 bulk action
- fork 新 scene "digest view" — 标题 "今日总结" + counts + 3-5 bulk action button
- bulk handler 跟 Phase 2 共享 (archive_batch / mark_done_batch)
- DND 检测 (用户开了 DND 跳过, 否则等首次活跃推送)

工作量预估 ~2d.
```

---

## 8. Phase 2 主要收获

见 §6 末尾 "Phase 2 主要收获" 段（写给 Phase 3 接力 session 的 Claude）。

---

**作者**：Claude Opus 4.7 (1M context), 代表 chenyqthu
**Phase 1 立项**: `09c7b66` (feat/agent-harness, MailAgent 主仓)
**Phase 2 ship**: 2026-05-26 (main `02f0e5f` → `5877fd8` → `7f9e066` + fork `bbcf85a` → `c10973c`)
**Phase 3 立项**: 等下个 session 起头
