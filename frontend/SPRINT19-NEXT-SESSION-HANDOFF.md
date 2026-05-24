# Sprint 19 Next-Session Handoff

> **当前进度**: P1 chat-history 全闭环 ship (sliding window / time decay / KOS save).
> 8 commit 本 session, ~1200 LOC, 109 vitest passed, typecheck:node + :web exit 0.
> **基线 commit**: `4bdc232` (P1-C UI [✨ 保存到 KOS]).

## 本 session ship 8 commits (上 session handoff 之后)

```
4bdc232 feat(chat-history): P1-C UI — AssistantMessageFooter 加 [✨ 保存到 KOS]
04c5f86 feat(chat-history): P1-C backend — chat:saveToKos IPC + KOS putPage service
a8dcaed feat(chat-history): P1-B — KOS query 加 client-side 时间衰减 rerank
b7734a8 feat(chat-history): P1-A — sliding window N=20 cap per-turn LLM history
e7414c9 docs(chat-history): Todo 1 设计调研 — sliding window + KOS ingest + 时间衰减
a79e988 fix(chat-session): 新建会话真创建 row + schema v4 drop UNIQUE
c46dd8d fix(frontend-ui): HoverTip 扩 side='left'/'right' 修 ChatSidebar 3 typecheck
0d6d287 fix(frontend-env): main 启动 load 项目根 .env + 加 4 KOS/harness flag whitelist
```

**关键事件**:
1. **Latent bug 发现**(commit `0d6d287`): Sprint 18 PR B 加 env-handler 给
   SettingsPage 读写项目根 .env, 但 main process 启动时**从不 load 这个
   .env**. 意味着 Sprint 18 至今 `MAILAGENT_AGENT_HARNESS=true` /
   `MAILAGENT_KOS_*` 等 flag **从未在 frontend 生效**. dotenv-bootstrap
   修了, boot log 从 `11 builtin tools (KOS consumer=off)` →
   `13 builtin tools (KOS consumer=on)`. 顺手加 4 个 KOS/harness flag
   到 MANAGED_ENV_KEYS whitelist 为将来 Settings UI tab.

2. **chat newSession bug 修复**(commit `a79e988`): Sprint 14 PR A 加
   sidebar 多 session 设计, 但 v1 schema 的 UNIQUE 漏 drop, 导致用户点
   [+ 新建会话] 后再发消息复活老 session. v4 migration drop UNIQUE,
   `chat:newSession` IPC 走 createNewSession 真 INSERT, useEmailChat 加
   forceNewSessionRef + send() 时调 chat.newSession. SQLite migration 关键
   细节: 必须 PRAGMA foreign_keys=OFF 出 transaction (DROP TABLE 在 FK
   ON 时是 implicit DELETE + CASCADE 会 wipe ai_chat_messages).

3. **Todo 1 chat-history 设计** + P1 全闭环 ship:
   - P1-A sliding window N=20 (dispatcher 用 `listLastNMessages` 替代
     full `listMessages`, 100-turn 单 turn cost 从 $0.6 降到约 $0.05)
   - P1-B client-side time-decay rerank (kos_query hits 乘 0.5^(Δt/14d)
     factor 重排序, default ON, 可 .env flag 关)
   - P1-C [✨ 保存到 KOS] backend + UI (AssistantMessageFooter 第 4 个
     按钮, click 调 chat:saveToKos IPC, 把 user→assistant 一对 message
     成 markdown page push KOS at `conversations/<email>-<sess>-<msg>`)

---

## P1 验证清单 (下次 session 第一件事 / user 自跑)

```bash
# 重启 Electron 让 v4 migration + 新 UI 加载
pkill -f "MailAgent/frontend" 2>/dev/null
sleep 2
cd /Users/chenyuanquan/Documents/MailAgent/frontend && pnpm dev
```

**Boot log 期望** (terminal 3-5 秒内打):
```
[dotenv-bootstrap] path=…/MailAgent/.env exists=true loaded=94/94 skipped=0
[Sprint 19] registered 13 builtin tools (KOS consumer=on): …
```

### P1-A sliding window 验证 (~5 min)

打开任一邮件 → chat 聊 25+ 轮 → sqlite 查 tokens_input 趋势应稳定不暴涨:

```bash
sqlite3 ~/.mailagent/frontend/ai_chat.db "
  SELECT role, tokens_input, model
  FROM ai_chat_messages
  WHERE session_id = (
    SELECT id FROM ai_chat_sessions ORDER BY id DESC LIMIT 1
  )
  ORDER BY id ASC LIMIT 30"
```

若超 20 turn 后 `tokens_input` 仍线性增长 → sliding window 没生效, 检查
dispatcher.ts:215 / 480 `listLastNMessages(session.id, HISTORY_WINDOW_SIZE)`
是否真用了 (vs `listMessages(session.id)`).

### P1-B KOS time-decay 验证 (~3 min)

```bash
# 触发 kos_query
# chat panel 问 "Bob 是谁?" 或 "Acme 项目最近怎么样" → LLM 调 kos_query
# main process console 看 KOSClient 调 + rerank 后 hits 顺序

# 关闭 rerank 对比 (优先级 1.5 倍 ≈ 14d 老 hit 跟新 hit 同分):
echo 'MAILAGENT_KOS_TIME_DECAY_ENABLED=false' >> /Users/chenyuanquan/Documents/MailAgent/.env
# 重启 Electron 再问同 prompt 对比 hits 顺序
# 测完恢复:
sed -i.bak '/^MAILAGENT_KOS_TIME_DECAY_ENABLED=/d' /Users/chenyuanquan/Documents/MailAgent/.env
```

### P1-C [✨ 保存到 KOS] 验证 (~3 min)

打开邮件 → chat 发 1 message + 等回复 → 看 assistant 底部第 4 个按钮
[✨ 保存到 KOS] → click → toast 显示 "已保存到 KOS / conversations/...".

KOS 端验证:
```bash
ssh chenyuanquan@100.98.144.119 \
  'curl -s -X POST "https://kos.chenge.ink/mcp" \
    -H "Authorization: Bearer $(cat ~/.gbrain/oauth-clients/mailagent-tok)" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/call\",\"params\":{\"name\":\"list_pages\",\"arguments\":{\"limit\":10,\"tag\":\"mailagent-chat\"}}}" \
    | grep ^data: | sed s/^data:.// | jq'
```

期望见 `conversations/<email>-<sess>-<msg>` slug 出现.

---

## 待办 (下次 session 接手)

### A — Todo 2 markdown 流式渲染业界方案调研 (~半 day 调研 + 半~1 day 实施)

User concern: 当前 `TranslatedBody.tsx` 自写 regex + DOMPurify + auto-balance
preprocess hacky, 不支持 nested list / table / code block triple ``` /
italic single `*`.

调研 priority 高到低:
1. claude.ai web (F12 看 DOM 怎么处理流式 chunk)
2. vercel/ai SDK `@ai-sdk/react` useChat hook
3. streaming-react-markdown lib
4. Cursor / Continue / Aider 编辑器集成 (GitHub 开源 read code)
5. ChatGPT web
6. shadcn/ai chat template
7. Karpathy nanochat / llm.c demo

输出 `docs/chat-markdown-streaming-research.md` 比较 (deps / LOC / GFM 覆盖 /
partial chunk 视觉跳动 / XSS / maintenance), 决定是否替换 TranslatedBody.

### B — 25 scenario eval (~1 hour)

跑 `docs/eval/email_scenarios.md` S01-S25 拿 pass rate:
- M1 P1 gate: ≥ 70% (≥ 14/20) on S01-S20
- KOS gate: ≥ 60% (≥ 3/5) on S21-S25

打开邮件 → chat panel Custom AI backend → 复制 prompt 一条条测 → 记
`docs/eval/p1-baseline.md`. 满足 gate 后翻 default flag (MAILAGENT_AGENT_HARNESS) +
合 main.

### C — P2 chat-history 改进 (1-2 day)

Phase 1 ship 后, design doc §4 列了 P2 项, 优先级取决于 P1 dogfood 数据:

| 子任务 | LOC | Blocker |
|---|---|---|
| **Cliff-summary** (代替 simple sliding) | ~250 | sliding window 跑稳 1 周, user feedback 老 turn 信息丢的问题 |
| **Auto-push session end** (KOS auto ingest) | ~400 | user 决策默认开/关 (privacy) |
| **KOS server-side time decay** | ~50 | Lucien availability sync gbrain time_decay param |

### D — M1 polish #3 + #4 (旧 handoff 待办, 仍 valid)

**#3 — MessageList ToolCallRow audit 渲染** (~300 LOC):
当前 harness 路径 tool_use / tool_result event 没渲染 audit 卡片.
user 看不到 LLM 调了什么 tool / input / output / 用了几秒. 实施 step:
1. `handlers/chat.ts` 加 `ipcMain.handle('chat:listToolCalls', ...)`
2. `shared/api/types.ts` ChatApi 加 `listToolCalls(messageId)`
3. ElectronApi/HttpApi 加实现
4. `MessageList.tsx` AssistantBubble 加 `useToolCalls(messageId)` hook +
   渲染折叠卡片 (折叠 show "(3 tools used) [▶]", 展开 show I/O JSON)
5. `useEmailChat.ts` tool_use/tool_result event handler 触发 refetch

**#4 — OpenAI Chat Completions tool_calls 增量协议** (~400 LOC):
fallback 链 `claude-sonnet-4-6 → gpt-5.4 → claude-opus-4-7` 命中 gpt-* 时
`custom_api.ts` disable harness (isAnthropicModel gate). 加 OpenAI 协议
tool_calls 增量 SSE 解析让 gpt 也能跑 multi-turn.

### E — D3 KOS slug namespace 跟 Lucien sync

P1-C `kos_save.ts` 用 default `conversations/<email>-<session>-<message>`,
但 KOS gbrain 可能已 dedicated namespace (notes/ / chat-history/ / 别的).
ping Lucien 一下:

```
你好, MailAgent chat agent P1 加了用户一键 [✨ 保存到 KOS] 把 assistant
回答 + 前 user 提问保存到 KOS. 现在用 default slug
conversations/<email-id>-<session-id>-<message-id>, frontmatter type:
conversation, tags: [conversation, mailagent-chat]. 看 gbrain 是否
有规范的 namespace 让我们 align? 比如 notes/<id> 还是
chat-history/<source>/<id>?
```

Lucien 决定后改 `frontend/src/electron/main/chat/kos_save.ts` SLUG_PREFIX
常量一处即可.

---

## 启动 (下次 session)

```bash
cd /Users/chenyuanquan/Documents/MailAgent
git log --oneline -10  # 确认 HEAD = 4bdc232 (或 user 之后 push 别的)
git status -s          # working tree 应该干净 (user calendar / island 改动已 commit)

cat frontend/SPRINT19-NEXT-SESSION-HANDOFF.md  # 看本 handoff
```

### 推荐顺序

1. **P1 verify** (15 min) — 跑上面 §"P1 验证清单" 3 个 P1-A/B/C 测试,
   有 bug 立即修, 无 bug mark P1 dogfood pass
2. **B 25 scenario eval** (1 hour) — 拿 pass rate 数据决定是否翻 default flag
3. **A Todo 2 markdown 调研** (半 day) — 大块独立任务
4. **C P2 chat-history** (depends on P1 dogfood data) — sliding window 跑稳后
5. **D M1 polish #3 / #4** (1-1.5 day) — 完整 ship M1
6. **E ping Lucien** — async, 等回应再改 slug

---

## Context

- M1 ship handoff: `frontend/SPRINT19-M1-HANDOFF.md` (旧)
- M2 plan: `frontend/SPRINT19-M2-PLAN.md` (PR 拆分表全 ✅)
- KOS 集成设计: `docs/kos-integration-design.md`
- Dogfood checklist: `docs/eval/m2-dogfood-checklist.md`
- Eval scenarios: `docs/eval/email_scenarios.md` (S01-S25)
- Todo 1 设计 doc: `docs/chat-history-design.md` (本 session ship, 含 D1-D6 6 决策点)
- Smoke script: `scripts/dev/kos_smoke_test.sh` (4/4 OK baseline)
- chat_db v4 migration: `frontend/src/electron/main/chat_db.ts:235` (PRAGMA
  foreign_keys=OFF out-of-transaction pattern, 关键细节注释里)

## 注意事项

1. **calendar / island working tree 改动** — 本 session 期间 user 在
   parallel 推 calendar Phase 2 + island Phase 1 commits. 我所有 fix 都
   精确 git add 自己改的文件, 不沾 calendar / island. 下次 session 同样
   原则.

2. **better-sqlite3 ABI mismatch 复发风险** — `pnpm dev` rebuild Electron
   ABI, vitest rebuild Node ABI. 每次切换跑测试前 `pnpm rebuild
   better-sqlite3` 一次. CI 应该自动这步 (no manual).

3. **dotenv-bootstrap 副作用** — 现在 frontend main process 启动会 load
   项目根 .env 注入 process.env. 之前所有 frontend 读 `process.env.X` 的
   flag (LLM_AGENT_ENABLED / KEEP_ALIVE_ENABLED 等 30+) 都开始**第一次
   真生效**. 若 user 报告某 flag 行为变了, 大概率是这个原因.

4. **chat_db v4 migration 已自动跑** — 用户 chat panel open 一次后
   schema_version 升到 4. 旧 v3 user data preserved (PRAGMA foreign_key_check
   过). 不需 手动操作.

5. **KOS [✨ 保存到 KOS] 默认 ON** — `isKosTimeDecayEnabled` default true.
   user 若想关掉 client-side rerank (debug / A/B 对比), `.env` 加
   `MAILAGENT_KOS_TIME_DECAY_ENABLED=false`. UI 按钮不受此 flag 影响 (按钮
   永远显示, 按下走 backend service 不论 rerank).

6. **HISTORY_WINDOW_SIZE = 20 hardcoded** — `dispatcher.ts` 文件顶部常量.
   想调整改一处. 后续 P2 加 env-based 可调即可.
