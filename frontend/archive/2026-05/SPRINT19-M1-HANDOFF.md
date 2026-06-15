# Sprint 19 M1 — Ship Handoff

> **状态**：✅ M1 已 ship 6 commits 到 `feat/agent-harness` 分支（2026-05-22/23）
> **待测**：⚠️ **尚未 dogfood**，本文档教你怎么测；默认 `MAILAGENT_AGENT_HARNESS=0` 关着，开 flag 才走新路径
> **下一步**：你跑 dogfood → 满足 eval gate → 翻默认 flag → 合 main → M2 启动

---

## 1. 6 个 commit 速览

```
ae6f7ca PR-1d.2 ConfirmToolDialog + renderer IPC wire           (630 LOC, 11 tests)
13d3b9f PR-1d.1 harness 外循环 + 3 写 tool + confirmation (main) (1740 LOC, 75 tests)
1b7ca07 PR-1c   Anthropic tool_use SSE + cache_control          (557 LOC, 22 tests)
ea51ab5 PR-1b   7 read tools + dispatch loop                    (1091 LOC, 30 tests)
1b2ff2c PR-1a   types + chat_db v3 + ToolRegistry skeleton      (729 LOC, 37 tests)
ab00431 P0      design doc + 20-scenario eval baseline          (1514 LOC, —)
```

**累计 ~6261 LOC / 146 tests / 9 test files 全通过**。

---

## 2. 怎么 dogfood（本地手动测）

### 2.1 启用 flag + 重启

```bash
# 1. 切到分支
git checkout feat/agent-harness

# 2. .env (前端) 加：
echo 'MAILAGENT_AGENT_HARNESS=1' >> frontend/.env.local
# 或者运行时 export 也行
export MAILAGENT_AGENT_HARNESS=1

# 3. 重启 Electron
cd frontend && pnpm electron:dev

# 4. 确认 flag 生效 — 主进程日志开头应看到 ToolRegistry 注册:
#    [Sprint 19] registered 10 builtin tools: email_search, email_get,
#    email_body, email_list_thread, email_search_fulltext,
#    email_get_ai_fields, attachment_list, email_flag, email_archive,
#    email_draft_reply
#    (日志输出位置：index.ts:registerBuiltinTools 调用，第一次有 chat session 创建时触发)
```

### 2.2 切到 Custom AI 后端

ChatPanel 顶部 BackendSelector → 选 **"Custom AI"**（Notion Agent 不支持 tool_use，会自动 fallback legacy 路径）。

### 2.3 跑 docs/eval/email_scenarios.md 20 scenario

打开任一邮件 → 开 AI Chat panel → 复制 scenario 的 prompt 粘进 composer → Send。

**期待观察**：

- **S01-S08 read-only**：iter 1 LLM 调 read tool → silent dispatch → tool_use / tool_result event 出现在 chat stream → iter 2 LLM 给文字回答 → done stopReason='end_turn'。
- **S09-S10 write (flag/archive)**：iter 1 LLM 调 `email_flag` / `email_archive` → **`ConfirmToolDialog` 弹出**（z-50 fixed overlay，glass card，preview tier 灰色 badge）→ Confirm → tool 真执行（看 Mail.app 邮件 read/flagged 状态变化）→ assistant 回 "已标"
- **S11 write (draft)**：iter 1 LLM 调 `email_draft_reply` → ConfirmToolDialog 弹（**edit tier 珊瑚色 badge** + **可编辑 textarea**）→ 改 body → Confirm → Mail.app 出现 draft，body 是你改过的版本（**不是** LLM 原版）
- **S12 batch flag reject**：LLM 应该拒绝（system prompt reject-list 暂未启用 P4 才加，所以 M1 这个 scenario 可能 fail，无所谓）
- **S14 multi-step**：iter 1 email_search → iter 2 email_body → iter 3 email_draft_reply → ConfirmToolDialog → Confirm → 草稿出现
- **S16 user cancel**：弹 ConfirmToolDialog → 点 Cancel → tool_result status='canceled' → LLM 优雅回 "好的不改了"

每 scenario 标记 PASS / FAIL，记入 `docs/eval/p1-baseline.md`（新文件）。

### 2.4 Pass rate 计算

按 `docs/eval/email_scenarios.md` §10：

| Phase Gate | 目标 | 计算 |
|---|---|---|
| **P1 (M1)** | ≥ 70% (≥ 14/20) | S01-S18 必过 16 个中 ≥ 13；S19/S20 (P2) 不计 |
| P2 | ≥ 85% (≥ 17/20) | 全 20 个 |
| P3 | ≥ 90% (≥ 18/20) | 全 20 个 |

每 scenario PASS 条件：
1. expected_tools 全部调到（顺序无关）
2. forbidden_tools 一次都没调
3. expected_substring 至少一个出现在最终 assistant 文字
4. 总 cost ≤ $0.10

---

## 3. 关键观察点（验证 design doc §5 关键设计是否正确）

### 3.1 Prompt cache 命中率

跑同一邮件 3 次 read-only query，看 main process 日志（custom_api.ts 的 usage event）：

- 第 1 次：`cache_creation_input_tokens > 0`，`cache_read_input_tokens = 0`
- 第 2 次：`cache_read_input_tokens > 0`（system + tools[] prefix 命中）
- 第 3 次：`cache_read_input_tokens` 更大（multi-turn history 也命中）

如果第 2 次 read 还是 0，看 design doc §5.1 排查（system blocks / tools[] 末尾 cache_control 配置）。

### 3.2 Tool use ID 跨轮稳定

multi-turn 时 `chat_tool_call.tool_use_id` 跟 backend 拿到的 toolu_xxx 完全相同：

```bash
sqlite3 ~/.mailagent/frontend/ai_chat.db "
  SELECT tool_use_id, tool_name, status FROM chat_tool_call
  WHERE message_id = (SELECT MAX(id) FROM ai_chat_messages WHERE role='assistant')
  ORDER BY id"
```

### 3.3 用户编辑生效

S17 / S11 起草 reply → ConfirmToolDialog edit body → Confirm → 查 chat_tool_call：

```bash
sqlite3 ~/.mailagent/frontend/ai_chat.db "
  SELECT input_json, user_edited_input_json
  FROM chat_tool_call
  WHERE tool_name='email_draft_reply'
  ORDER BY id DESC LIMIT 1"
```

`user_edited_input_json` 应该不为 NULL 且 body_markdown 是你改的版本。

打开 Mail.app drafts，看草稿 body 是你的版本（不是 LLM 原版）。

### 3.4 Cost telemetry

```bash
sqlite3 ~/.mailagent/frontend/ai_chat.db "
  SELECT
    DATE(created_at/1000, 'unixepoch') AS day,
    COUNT(*) AS runs,
    AVG(cost_usd) AS avg_cost,
    SUM(cost_usd) AS total_cost
  FROM ai_chat_messages
  WHERE role='assistant' AND cost_usd IS NOT NULL
  GROUP BY day ORDER BY day DESC LIMIT 7"
```

P1 gate 期望：**read-only query cost 跟 single-turn baseline ±10% 之内**（因为 cache 命中应该补偿掉额外 iter 的 input token 重发）。如果差很多看 §3.1 cache 排查。

---

## 4. 已知未做（不影响 dogfood）

- **MessageList ToolCallRow 渲染 chat_tool_call audit 行**：现在 ChatPanel 里 tool_use / tool_result event 只 forward 到 sink 不渲染（dispatch 时 `chat_tool_call` 已经写库）。UI 看起来 assistant 还在 streaming 但实际 tool 已经执行 + ConfirmToolDialog 已经弹（用户能感知）。P4 polish 时升级 ToolCallRow 接 listToolCalls(messageId) 显示折叠卡片。
- **OpenAI tool_calls 增量协议**：M1 仅 Anthropic 协议。fallback 链命中 gpt-5.5 时 backend 会自动 disable harness（custom_api.ts:isAnthropicModel gate） — 期望行为，gpt-5.5 收到 tools 数组也不会 SSE tool_use，会直接 fallback 文字回话。
- **System prompt reject-list**：P4 才加，所以 S12 "把收件箱全部标已读" 这种 LLM 可能真的去做。dogfood 时遇到先手动 abort。
- **per-tool throttlePerMinute 实施**：当前 ToolDef 已声明 throttlePerMinute 字段但 dispatch.ts 没真 enforce —— P4 才加。dogfood 期注意别让 LLM 死循环调同一个 write tool。

---

## 5. 测试已通过的事

✅ pnpm typecheck:node + typecheck:web exit 0
✅ vitest tests/main/chat tests/main/chat_db.test.ts tests/main/chat_dispatcher.test.ts tests/shared/ConfirmToolDialog.test.tsx → 9 files / 146/146 passed
✅ chat_db migration v2 → v3 兼容旧 DB
✅ legacy single-turn 路径 (flag off) 完全不变，21 个现有 chat_dispatcher.test.ts case 全过
✅ Anthropic SSE tool_use 累积 + stop_reason / cache_control 双 breakpoint 单测覆盖
✅ Dispatch 并行读 + 串行写 + confirmation flow + abort propagation
✅ Harness loop MAX_ITER / MAX_COST_USD / abort / unknown tool 各路径单测
✅ ConfirmToolDialog 11 个 UI 测试（preview / edit / busy state / keyboard）

## 6. 回归风险（dogfood 时如发现立即报）

- chat_db v3 migration 在线上 v2 DB 是否能升级（idempotent + 不丢数据）—— `chat_db.test.ts` "v1-version DB ALTERs in the metadata column on first open" + 我新加的 "v3 tables exist post-migration" 已覆盖
- legacy single-turn 路径（notion-agent + flag off）行为是否变 —— 21 个现有 dispatcher 测试全过验证
- prompt cache miss 暴涨 —— 见 §3.1 测试方法
- ConfirmToolDialog 多 dialog 排队（同 turn LLM 调 2 个 write tool）是否正确串行 —— `dispatchTools` 串行 + dialog 队列头取 + setState splice
- 切换邮件 / 关 panel 时 pending dialog 是否正确清掉 —— useEmailChat email-switch reset block 已加

## 7. M2 起点

dogfood 通过后 M2 起点（参见 `docs/architecture_agent_harness.md` §9）：
- PR-2a FTS5 中文 smart wrapper
- PR-2b 附件文本化（pypdf/python-docx/python-pptx/xlsx）
- PR-2c-2d Wiki 数据访问 + 4 读 wiki tool + L1 hot block 注入

LLM Wiki 借鉴 gbrain 两个低成本闪光点（`[[wiki/path]]` 自动 link + `## Facts` 围栏），**不内嵌 gbrain 本体**（架构错配，详见 architecture doc §1.2 + §9）。
