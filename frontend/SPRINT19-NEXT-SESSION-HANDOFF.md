# Sprint 19 Next-Session Handoff

> **当前进度**: M2 全 7 个 PR ship (PR-2a 到 PR-2g) + M1 polish #1+#2 ship.
> **本 session ctx 91% 收尾**. 下次 session 三个 todo + dogfood 续验.
> **基线 commit**: `9d498ea` (chat-ui 字号 + markdown auto-balance fix).

## 已 ship (本 session 全量)

```
9d498ea fix(chat-ui): Composer textarea 字号修正 + streaming markdown auto-balance
dcec46a fix(agent-harness): EmailContext 加 AI 字段 (ai_priority/ai_action/processing_status)
363752a fix(agent-harness): registerBuiltinTools 加 boot log + dogfood-checklist 命令名修正
f8e9213 docs(agent-harness): dogfood-checklist 加明确 user 待办指引
f9b17af fix(agent-harness): PR-2d producer 加 LLM 中文 priority enum 映射
55b1b44 feat(agent-harness): M1 polish #1 + #2 — reject-list + per-tool throttle
5bc40a8 feat(agent-harness): PR-2g — M2 dogfood 包 ship
0cdb9a2 feat(agent-harness): PR-2f — L1 hot block KOS sender digest 注入
3cea550 feat(agent-harness): PR-2d + PR-2e — KOS producer + consumer chat tools
9c8e302 feat(agent-harness): PR-2c — KOS MCP client (TS + Py 双份)
05cf071 feat(agent-harness): PR-2b — 附件文本化 + FTS5
4e68381 feat(agent-harness): PR-2a — FTS5 中文 smart wrapper
```

**测试**: 后端 215 + 前端 251 = 466 全过. (后端含 KOS 客户端 39 + producer 45 = 84 子集; 前端含 KOS 客户端 36 + chat tools 21 + L1 hot block 28 + throttle 8 + markdown 13 = 106 子集.)

---

## Todo 1 — 历史对话持久化 + 入库 + 检索 (重要, 设计 + 调研)

**User question**: "现在的历史会话真的会缓存么？这个很重要，因为有时候历史对话中也有重要信息，这些也应该能入库被检索和使用，按照对话时间距离的远近加上不同权重。"

### 当前状态盘点 (下次 session 第一件事)

跑这几个命令搞清当前 chat 历史持久化机制:

```bash
# 1. chat history 存哪里
ls -la ~/.mailagent/frontend/ai_chat.db
sqlite3 ~/.mailagent/frontend/ai_chat.db ".schema ai_chat_sessions"
sqlite3 ~/.mailagent/frontend/ai_chat.db ".schema ai_chat_messages"
sqlite3 ~/.mailagent/frontend/ai_chat.db "SELECT COUNT(*) FROM ai_chat_messages"

# 2. harness 怎么 load history (是不是真的喂给 LLM)
grep -n "chatHistoryToAnthropic\|priorTurns\|initialHistory" \
  frontend/src/electron/main/chat/harness.ts \
  frontend/src/electron/main/chat/dispatcher.ts

# 3. KOS producer 推不推 chat 历史
grep -rn "push.*chat\|chat.*ingest\|chat_message" src/kos/ src/mail/new_watcher.py
```

### 调研 + 设计要做的

1. **现状确认** — chat history 已存 SQLite (`~/.mailagent/frontend/ai_chat.db`, table `ai_chat_messages`). 但 LLM **每次 turn 看到多少历史**? 全部还是 last N? 还是 token-budget cap?
   - 推测: dispatcher 用 `listMessages(sessionId)` 拉全部 + harness `chatHistoryToAnthropic` 转 Anthropic message[] 喂回 LLM → 长 session token 暴涨.
   - 待定方案: 实施 sliding window + summary (cliff-summary 长 session 头部, recent 全留).

2. **入 KOS 让跨 session 检索** — 当前 chat 历史**没**推 KOS. PR-2d producer 只推 email source. 若想让 chat 也跨 session 可查:
   - 新 producer entry: chat session done 时把 user+assistant message 拼成 markdown → push 到 `chat-history/<session-id>` slug.
   - 但要 careful: chat 可能含 sensitive context (用户对邮件的评论), 是否进图谱要 user 显式开关.
   - 调研 KOS gbrain 是否有 dedicated `conversations/` namespace 已设计 (mac mini 那边问 Lucien).

3. **时间衰减权重 retrieval** — KOS query 排序默认按 bm25 + entity boost. 时间因子要么:
   - (a) client 端 retrieve 后 rerank — 给最近 7d hits 权重 ×2, 30d 内 ×1, >30d 衰减.
   - (b) KOS 端 server-side time decay — 调研 gbrain 是否已支持 (`updated_after` filter + score modifier).
   - 推荐 (b) 跟 KOS 自带能力 align. 若没 ping Lucien 看是否能加.

### 输出物 (下次 session 应该 ship)

- `docs/chat-history-design.md` — 当前 SQLite 持久化机制 + 是否喂 LLM 现状 + sliding window / summary 改造方案 + KOS ingest 闭环设计
- 实现 + tests (~500-800 LOC, 跟 PR-2d producer 同等 size)

**Blocker**: 若 KOS 端时间衰减 API 没现成, 跟 Lucien 同步先 (跟当时 wire spec 一样路径).

---

## Todo 2 — Markdown 流式渲染业界最佳方案调研

**User question**: "markdown 流式渲染的方案有点复杂，claude / openclaw 之类的，业界都是这么做的么？最好调研下，按照业界最佳方案来做。"

### 我现在用的方案 (本 session ship `9d498ea`)

`TranslatedBody.tsx` 自写 regex-based markdown → HTML + DOMPurify, 加 `autoBalanceTrailingMarkers` preprocess 流式时给 unclosed `**` / `` ` `` append closing marker. 工作但 hacky:
- 不支持 nested list / table / footnote 等复杂 markdown
- italic single `*` 没处理 (易跟 `**` 截断冲突)
- code block triple ``` 没处理 (现在没 case 受影响, 但未来 LLM 输出代码就会)

### 业界方案调研 task

调研下面几个 reference, 看 chat agent UI 流式 markdown 怎么做 (调研 priority 高到低):

1. **claude.ai web** — Anthropic 自家. F12 看 Network + DOM, 流式 chunk 怎么转 markdown. 推测用 `react-markdown` + custom plugin handle partial.
2. **ChatGPT web** — OpenAI. 同上 inspect.
3. **Cursor / Continue / Aider** — 编辑器集成. 它们 GitHub 开源, 直接 read code.
4. **shadcn/ai chat template** — 业界 React + Tailwind chat template 典范.
5. **vercel/ai SDK** — `@ai-sdk/react` `useChat` hook 自带 streaming markdown 处理. **强候选**.
6. **streaming-react-markdown** lib — 专门为流式设计 (`https://github.com/streaming-react-markdown` 或类似).
7. **Karpathy nanochat / llm.c demo** — Karpathy 风格的 minimal chat UI, 看他怎么处理.

### 评判维度

调研后比较 (输出 `docs/chat-markdown-streaming-research.md`):

| 方案 | 加 deps? | LOC | 支持完整 GFM (table/code block/footnote)? | partial chunk 视觉跳动? | XSS sanitize? | maintenance? |
|---|---|---|---|---|---|---|

### 推荐执行

如果业界主流是 `react-markdown` + 流式 plugin → 替换 `TranslatedBody.tsx` 自写 regex parser. 工作量 ~300-500 LOC (含 fallback to DOMPurify sanitize layer).

如果业界主流就是 auto-balance preprocess (跟我现在一样) → 不动, 但可能加 single `*` italic + triple ``` code block 处理.

### 输出物

- `docs/chat-markdown-streaming-research.md` — 调研结论
- (若需) 替换 TranslatedBody 实现 + 测试

---

## Todo 3 — User 下一步 dogfood 测什么

工具已加载 (你刚看到 LLM 列出 7 个 tool), AI 字段已注入 system prompt (commit `dcec46a` ship). 接下来 verify:

### 立即可测 (5 min)

**T1 — 重启 Electron + 看 boot log** (commit `363752a` 加的):
```bash
pkill -f electron-vite 2>/dev/null; pkill -f Electron 2>/dev/null
cd /Users/chenyuanquan/Documents/MailAgent/frontend && pnpm dev 2>&1 | grep "Sprint 19"
```
期望: `[Sprint 19] registered 13 builtin tools (KOS consumer=on): attachment_list, ...`

**T2 — 打开邮件 012, 看 chat 第一轮回答有没 AI label** (commit `dcec46a` ship 的):

之前 LLM 回答只总结邮件内容; 现在 system prompt 加了 `AI labels: priority=🟡 重要 / action=...`, 期望 LLM 开场就说 "AI 已分类为 🟡 重要 / 需要决策, 建议先 ..." 这类含 AI 标签判断的话.

如果还没看到 AI 标签判断 → 看 main process console 看 system prompt 注入是否含 `AI labels:` 一行 (临时 console.log 进 buildEmailContextSection 看).

**T3 — chat 输入框字号 + bubble 字号** (commit `9d498ea` ship 的):

输入框现在 14px, 跟 message bubble 视觉对齐. 主观看一眼即可.

**T4 — 长一点的 chat 主动调 kos_query / email_search_fulltext**:

随便打开一个常用 sender 邮件, 问 "这个发件人之前还跟我聊过什么? 主题搜一下"
期望: LLM 主动调 `kos_query` 或 `email_search_fulltext` tool, ToolCallRow 在 message bubble 上方 (虽然 polish #3 audit row 没 ship, 但 main process console 应该有 dispatch log).

### M1 harness 20 scenario (~30 min)

跑 `docs/eval/email_scenarios.md` S01-S20, 每个 prompt 复制到 chat panel 测. 记 pass rate **≥ 70% (≥ 14/20)** = P1 gate 过.

### KOS 5 scenario (~15 min)

跑同文档 S21-S25 (PR-2g 新加, KOS 专属). 记 pass rate **≥ 60% (≥ 3/5)**.

### Producer 真启用 (long-running)

按 dogfood-checklist §4.1 → §4.2 → §4.3 步骤, 关掉 `KOS_INGEST_DRY_RUN`, 跑 mail-sync 几小时, 看 KOS 端 `list_pages tag=mailagent-ingest` 出现新 page.

### 长期监控 (1 周)

dogfood-checklist `§监控指标` 给的 sqlite3 + pm2 log grep 命令, 1 周收 cost / error 率 / latency baseline. 满足后翻 default flag.

---

## M1 polish 剩余

本 session ship #1 + #2 (reject-list + throttle); 剩 2 项:

### #3 — MessageList ToolCallRow audit 渲染 (~300 LOC)

当前 harness 路径 (PR-1d 之后) tool_use / tool_result event 没渲染 audit 卡片. user 在 chat panel 只看到 ConfirmToolDialog + 最终 assistant 文字, 看不到 LLM 调了什么 tool / input / output / 用了几秒.

实施步骤:
1. `handlers/chat.ts` 加 `ipcMain.handle('chat:listToolCalls', (_, mid) => listToolCallsForMessage(mid))`
2. `shared/api/types.ts` ChatApi interface 加 `listToolCalls(messageId): Promise<ChatToolCall[]>`
3. `ElectronApi.ts` + `HttpApi.ts` 加实现
4. `MessageList.tsx` AssistantBubble 加 `useToolCalls(messageId)` hook + 渲染折叠卡片 (折叠状态 show "(3 tools used) [▶]", 展开 show input/output JSON)
5. `useEmailChat.ts` line 369 tool_use/tool_result event handler 触发 refetch
6. 测试 (UI + IPC)

### #4 — OpenAI Chat Completions tool_calls 增量协议 (~400 LOC)

当前 fallback model 链 `claude-sonnet-4-6 → gpt-5.4 → claude-opus-4-7`, gpt-* 命中时 `custom_api.ts` disable harness (isAnthropicModel gate). 加 OpenAI 协议 tool_calls 增量 SSE 解析:
- request body 改 `tools: [...].map(toOpenAIFunctionDescriptor)`
- SSE response 解析 `delta.tool_calls[i].function.{name, arguments}` 累积
- adapter to harness ToolUseEvent shape

让 gpt-5.4 在 Anthropic 上游挂时也能跑 multi-turn harness.

---

## 启动 (下次 session 第一步)

```bash
cd /Users/chenyuanquan/Documents/MailAgent
git log --oneline -3  # 确认 HEAD = 9d498ea
git status -s         # 看 working tree (calendar UI 改动可能还在 unstaged)

# 看本 handoff
cat frontend/SPRINT19-NEXT-SESSION-HANDOFF.md
```

### 推荐顺序

1. **Todo 3 T1+T2+T3** (5 min) — 把本 session 已 ship 的 fix verify 一下
2. **Todo 1** (1-2 day) — chat 历史持久化设计 + 实施 (最重要 user concern)
3. **Todo 2** (半 day 调研 + 半 day-1 day 实施) — markdown 业界方案
4. **M1 polish #3** (半 day) — ToolCallRow audit
5. **M1 polish #4** (1 day) — OpenAI tool_calls
6. **Todo 3 长链 dogfood** — 20+5 scenario + producer 真启用 + 监控

---

## Context

- M1 ship handoff: `frontend/SPRINT19-M1-HANDOFF.md` (旧)
- M2 plan: `frontend/SPRINT19-M2-PLAN.md` (PR 拆分表全 ✅)
- KOS 集成设计: `docs/kos-integration-design.md`
- Dogfood checklist: `docs/eval/m2-dogfood-checklist.md`
- Eval scenarios: `docs/eval/email_scenarios.md` (S01-S25)
- Smoke script: `scripts/dev/kos_smoke_test.sh` (4/4 OK baseline)

## 注意事项

1. **calendar UI working tree 改动** — 几次 git status 看到 user 自己的 calendar 视觉 work 一直在 unstaged 状态. 跟 agent-harness 无关, 别动. 下次 session 别意外 `git add .`.

2. **better-sqlite3 ABI mismatch** — Node 跟 Electron 版本不同会 NODE_MODULE_VERSION 错. 跑 vitest 前先 `pnpm rebuild better-sqlite3`; 跑 Electron 前 `pnpm dev` 内部已 rebuild 走 Electron target.

3. **KOS 凭据安全** — `KOS_OAUTH_CLIENT_ID` + `_SECRET` 在 `.env` (gitignored). 别 commit 进 repo. Lucien 在 mac mini `~/.gbrain/oauth-clients/mailagent.json` 存 source.

4. **M2 默认全 OFF** — 4 个 KOS flag 默认 false. 上次 session 我跑 producer dry-run 时改过, 跑完手动恢复 false 了. 确认 `.env` 看一眼.
