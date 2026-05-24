# Chat History Persistence + KOS Ingest + 时间衰减 Retrieval — 设计文档

> Sprint 19 Todo 1 / 起点 commit `a79e988` (chat-session bug fix ship)
>
> **问题来源**: user 2026-05-23 dogfood 发现 chat history 机制有 3 个未规划盲区:
> (1) 长 session token 暴涨 (LLM 看 full history 每轮);
> (2) 跨 session 知识无法检索 (chat 不推 KOS);
> (3) 时间衰减权重未实现 (KOS 默认 bm25, 旧记忆跟新记忆同权重).
>
> **范围**: 这份文档是设计调研 + 方案选型, 不动代码. 实施需 user approve
> 决策点后开 P1/P2/P3 ship PR.

---

## 1. 现状盘点 (frozen at commit `a79e988`)

### 1.1 持久化机制 — chat_db (SQLite, frontend-owned)

- **文件**: `~/.mailagent/frontend/ai_chat.db` (override via `$AI_CHAT_DB_PATH`)
- **Schema v4** (Sprint 19 bug-fix ship):
  ```
  ai_chat_sessions: id PK + email_id + backend_kind + backend_model
                    + backend_agent_page_id + created_at + updated_at
                    (无 UNIQUE 后, 多 session per email 允许)
  ai_chat_messages: id PK + session_id FK CASCADE + role + content
                    + tokens_input/output + cost_usd + model + status
                    + error_message + metadata + created_at + updated_at
  chat_tool_call:   id PK + message_id FK CASCADE + tool_use_id + tool_name
                    + input_json + user_edited_input_json + output_json
                    + status + duration_ms + confirmation_tier + confirmed_at
                    + created_at + updated_at
                    (Sprint 19 PR-1a — agent harness audit)
  wiki_pages:       path PK + scope + slug + body_markdown + refs_json
                    + source_messages_json + updated_by + mtime_ns +
                    created_at + updated_at
                    (Sprint 19 PR-1a — 设计为 LLM Wiki SSoT, 未启用)
  wiki_fts:         FTS5 virtual table mirroring wiki_pages.body_markdown
  agent_memory_kv:  (scope, key) PK + value_json + source_wiki_path +
                    created_at + updated_at
                    (Sprint 19 PR-1a — gbrain-style structured Facts, 未启用)
  ```
- **当前实测数据** (2026-05-23):
  - sessions=3, messages=8, tool_calls=0
  - 都是 dogfood / 测试遗留, 不代表 production volume.

### 1.2 LLM 看多少 history — harness 路径

`frontend/src/electron/main/chat/harness.ts:78` `chatHistoryToAnthropic`:
```typescript
function chatHistoryToAnthropic(history: ChatMessage[]): AnthropicHistoryMessage[] {
  const out: AnthropicHistoryMessage[] = []
  for (const m of history) {
    if (m.role === 'user') {
      if (m.content.length > 0) out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.status === 'aborted' || m.status === 'error') continue
      if (m.content.length > 0) out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}
```

- **零截断**: 把 SQLite 拿到的 `ChatMessage[]` 全部 forward 给 LLM
  (`dispatcher.ts:189` `listMessages(session.id)` 拿 session 全部 messages)
- **零 token budget check**: 不检查 token 数, 不评估 cost
- **唯一过滤**: skip `aborted`/`error` assistant rows
- **multi-turn 增量**: 同一 turn 内 (iter ≥ 2) tool_use/tool_result 块在
  `priorTurns` 内存数组累加, 不写 DB, 下次 turn 重新从 DB 拿 history

**含义**: 单 session 用户聊 N 轮, 第 N 轮 input tokens ≈
`system (10K) + tools (3K) + N × avg_turn_tokens`.
M1 prompt cache 仅缓存 system + tools 末尾两个 breakpoint,
**history 部分每轮 cache miss**.

实际成本影响 (Sonnet 4.6, $3/M input + $0.30/M cached input):
- 1 turn: ~5K input → $0.015
- 10 turns: history ~20K + system 13K cached → $0.063 (≈4× 1-turn)
- 30 turns: history ~60K + system 13K cached → $0.184 (≈12× 1-turn)
- 100 turns: history ~200K + system 13K cached → $0.605 (≈40× 1-turn)
  且接近 Sonnet 4.6 200K context window 上限.

### 1.3 KOS producer 推什么 (commit `f9b17af` ship 之后)

`src/kos/producer.py:110 build_kos_page_payload` + `_maybe_trigger_kos_hook`
(`src/mail/new_watcher.py:759-829`):
- **触发点**: 新邮件 sync → Notion sync 成功 → 异步 push to KOS
- **payload slug**: `sources/mailagent-{message_id_normalized}`
- **payload body**: YAML frontmatter (type/title/source_of_truth/tags/
  ai_priority) + markdown 邮件正文
- **filter**: `priority_at_or_above(floor='normal')` 决定推不推
  (low/normal 跳过, important/urgent/critical 推)
- **不推 chat**: 整个 producer pipeline 只 entry-point email sync, **chat
  history 完全 invisible 给 KOS**

### 1.4 design doc 原规划

`docs/agent-harness-design.md` §1.1 + §2.2 + §4.7 原计划:
- **M1**: per-email session, no memory across email
- **M2**: Wiki context 4 层注入 + cache_control (LLM Wiki SSoT)
- **M3**: 跨 session memory (sender / project / mailbox.outbox.style scope)
- **M4**: Guards + Polish + Rollout

注意 — **同 session 内 sliding window / summary 完全没规划**.
M3 跨 session memory 是 entity-level (sender / project),
而非 message-level (chat turn). 是两个正交问题.

KOS 集成设计 (`docs/kos-integration-design.md`) 也只规划 producer 推 email +
consumer 查 entity (people/project slug), 不规划 chat history 入库.

---

## 2. 问题分析

### 2.1 单 session token 暴涨 (重要程度: 🟡 中)

- 当前测试 messages=8 / session 还小, 但 dogfood 会涨快
- M1 设计的 prompt cache 双 breakpoint 只覆盖 system + tools,
  history 每轮 cache miss
- 100 turns 单 session 估算 cost ≈ $0.6/turn, **会快速吃 user 月度
  LLM 预算**

### 2.2 跨 session 知识无法检索 (重要程度: 🟠 中-高)

- user 在某邮件 session 跟 LLM 讨论的内容 (比如"这家供应商的合同条款 X
  上次提到我们需要 Y") 永远停留在该 session
- 切到另一邮件开新 session, 知识丢失
- 即使 KOS 里有该 vendor 的 entity digest, chat 讨论的 nuance 不在
  KOS 里 (chat 不推)
- user concern 原话: "历史对话中也有重要信息, 这些也应该能入库被检索和使用"

### 2.3 时间衰减权重 (重要程度: 🟢 低-中)

- KOS query 默认按 bm25 + entity boost 排序, 不考虑时间维度
- user concern 原话: "按照对话时间距离的远近加上不同权重"
- 实施动机: 老对话 vs 新对话同权重命中, 可能让 LLM 引用过时信息
- 但需考虑: KOS query 用户对象不只 chat (还有 email / Notion / Slack 等),
  时间衰减全局加还是仅 chat-source 加, 是设计点

---

## 3. 方案设计

### 3.1 单 session sliding window + summary

**目标**: 让 100-turn session 的 input tokens 跟 10-turn session 接近.

**方案 A — 简单 sliding window** (推荐 P1):
- 每次发 LLM 前, history 截 last N turns (默认 N=20)
- 老 turn 完全丢弃, LLM 看不到
- 实施: `dispatcher.ts:189` `listMessages(...)` 改成 `listLastNMessages(session.id, N=20)`
- LOC: ~30 (新 sql query + N const)
- 优点: 简单, 0 LLM 调用, 0 latency
- 缺点: 老 turn 信息丢, user 问"上面 60 轮前我说的 X 是啥意思"答不上

**方案 B — Cliff-summary** (P2):
- 当 history.length > THRESHOLD (默认 20), 把头部 (history.length - 10)
  条 turn 总结成 1 个 system message ("Summary of earlier conversation: ...")
- 总结结果存进 chat_messages 表新字段 `summary_for_turn`, 跨同 session
  保留 (避免重复总结)
- 实施: 新 summarizer 函数 (调 Haiku 4.5 节省成本) + summarize_messages
  table 跟踪状态
- LOC: ~250 (含 summarize service + 缓存)
- 优点: 老 turn 信息部分保留 (压缩成 summary)
- 缺点: 加 LLM 调用 + summarize 失败 fallback 复杂

**方案 C — Token budget cap** (P3, 配合 A/B):
- max_input_tokens 配置 (e.g. 60K for Sonnet 4.6)
- 每次 build history 时算 token + cliff 老 turn 直到 input < cap
- LOC: ~100 + 装 tiktoken-js or anthropic count_tokens API

**决策点 D1**: P1 用方案 A 还是直接上 B?

### 3.2 KOS chat ingest (跨 session)

**目标**: 让 chat 讨论的关键信息进 KOS, 跨 session 可检索.

**方案 A — User-explicit save** (推荐 P1):
- chat panel 加 [✨ 保存到 KOS] 按钮 (每条 assistant message 后)
- 点击后弹 dialog 让 user 选 KOS slug (default 推到
  `conversations/<email-subject-slug>` 或 `notes/<auto-summary>`)
- 后端调 KOSClient.put_page (TS 端 `frontend/src/electron/main/kos/client.ts`
  已有 method)
- LOC: ~250 (UI 按钮 + dialog + KOS put_page wiring)
- 优点: 安全 (user opt-in 显式), 防 sensitive context (邮件评论) 误推
- 缺点: user 习惯依赖 — 多数 user 不会点

**方案 B — Auto-push on session end** (P2):
- session 关闭 (panel close / 切邮件 / N 分钟无 activity) 时, 整 session
  转 markdown ("User: ... Assistant: ..." chronological), push to
  `conversations/<session-id>` slug
- 加 `MAILAGENT_KOS_CHAT_INGEST_ENABLED=false` flag 默认关
- LOC: ~400 (含 session lifecycle hook + 转 markdown + push)
- 优点: 全 chat 自动入图谱, 跨 session 可查
- 缺点: privacy 风险 (user 不知道在 push), KOS storage 涨快, 可能 push
  大量低价值 chat (短问 + 答)

**方案 C — Smart auto-push** (P3):
- 只 push "高价值" turn — heuristic: assistant message length > 500 字
  且含 entity / 关键事实 / decision keyword (e.g. "决定" / "建议")
- 或调 LLM judge (Haiku) 给每个 turn 打 "useful for memory" 分
- LOC: ~500 (heuristic 不需 LLM 调用, judge 需要)

**决策点 D2**: KOS chat ingest 用哪个方案? 默认开还是关?

**决策点 D3**: KOS slug namespace 用 `conversations/<id>` 还是
`chat-history/<id>` 还是 `notes/<id>`? (需跟 Lucien sync gbrain 是否已
有 dedicated namespace)

### 3.3 时间衰减权重 retrieval

**目标**: KOS query 返 hits 时, 老 record 权重低.

**方案 A — Client-side rerank** (推荐 P1, 不依赖 KOS 端改):
- chat tool `kos_query` 拿 KOS 返 hits 后, 在 frontend (TS) 按
  `updated_at` 加 score 调整:
  ```
  if (Date.now() - hit.updated_at < 7d) score *= 1.5
  else if (Δt < 30d) score *= 1.0
  else if (Δt < 90d) score *= 0.7
  else score *= 0.4
  ```
- 实施: `frontend/src/electron/main/kos/client.ts` 加 `rerankByRecency`
  helper
- LOC: ~80 + test
- 优点: 不需 KOS 端改, 立即可用; 给 chat-source 加权独立可控
- 缺点: 只影响 chat agent 的 KOS query, 其他 KOS 消费者 (Notion Knowledge
  Agent / Openclaw / Feishu signal) 不享受

**方案 B — KOS server-side** (P2, blocked on Lucien):
- KOS query 加 `time_decay` param: `query(q, limit, time_decay='exp(-Δt/14d)')`
- 全消费者享受时间衰减
- 实施: 需 gbrain 端加 param + 算 score 时乘
- LOC: 0 frontend (just pass through param) + N LOC mac mini
- 优点: 全局, consistent
- 缺点: blocked on Lucien availability

**决策点 D4**: P1 用 client-side rerank, 同时 ping Lucien 看 server-side
能不能上线 P2?

**决策点 D5**: 时间衰减常数 τ (半衰期) 默认值? 14d 太短 还是 30d?
跟 user chat 节奏关系.

---

## 4. 实施 phase

| Phase | 内容 | LOC | Blocker | 优先级 |
|---|---|---|---|---|
| **P1** | sliding window N=20 (方案 3.1 A) | ~30 | 无 | 🟠 高 |
| **P1** | KOS [✨ 保存到 KOS] 按钮 (方案 3.2 A) | ~250 | 无 | 🟢 中 |
| **P1** | Client-side time decay rerank (方案 3.3 A) | ~80 | 无 | 🟢 中 |
| **P2** | Cliff-summary (方案 3.1 B) | ~250 | sliding window 跑稳 1 周 | 🟢 低 |
| **P2** | Auto-push session end (方案 3.2 B) | ~400 | user 决策默认开/关 | 🟢 低 |
| **P2** | KOS server-side time decay | ~50 | Lucien availability | 🟢 低 |
| **P3** | Token budget cap (方案 3.1 C) | ~100 | 上线 metrics 观察 | 🔴 低 |
| **P3** | Smart auto-push (方案 3.2 C) | ~500 | dogfood 跑量 | 🔴 低 |

**估算总 P1 工作量**: ~360 LOC + tests, 1-2 day.

---

## 5. 决策点汇总 (需要 user approve 才能开 PR)

| ID | 决策 | 选项 | 推荐 |
|---|---|---|---|
| D1 | P1 用 sliding window 还是 cliff-summary | A 简单 sliding (~30 LOC) / B summary (~250 LOC) | **A** — KISS, 实测后再加 B |
| D2 | KOS chat ingest 模式 | A user-explicit / B auto-push / C smart | **A** — 隐私第一 |
| D3 | KOS slug namespace | `conversations/<id>` / `chat-history/<id>` / `notes/<id>` | **需 ping Lucien** 看 KOS 已有规范 |
| D4 | 时间衰减 client-side 先做? | 是 / 等 server-side | **是** — 立即可用, 不 block |
| D5 | 时间衰减半衰期 τ | 7d / 14d / 30d | **14d** — 跟邮件回复节奏匹配 |
| D6 | sliding window N | 10 / 20 / 50 | **20** — 大部分 dogfood session < 20 turn, 不影响日常 |

---

## 6. 监控指标 (P1 ship 后)

跑 1 周收 baseline:
- 单 turn input tokens (p50 / p90 / p95)
- 单 turn cost (p50 / p90 / p95)
- session 长度分布 (% 超 20 turn / % 超 50 turn)
- KOS query 命中率 + 平均 score
- [✨ 保存到 KOS] 按钮点击率 (P1 ship 时)

---

## 7. 关联文档

- 起点 bug fix: commit `a79e988` (chat-session newSession + v4 migration)
- M2 KOS 集成 design: [`docs/kos-integration-design.md`](./kos-integration-design.md)
- Agent harness design (原规划): [`docs/agent-harness-design.md`](./agent-harness-design.md)
- KOS producer 现状: `src/kos/producer.py` + `src/mail/new_watcher.py:759`
- chat_db schema: `frontend/src/electron/main/chat_db.ts:188-330`
- chat history loader (zero truncation): `frontend/src/electron/main/chat/harness.ts:78`

---

## 8. Open questions

1. cliff-summary 用 Haiku 4.5 总结合理 — 但 system + tools cache 失效, summarize 那次调用本身 cost 多少? 需测.
2. KOS chat ingest 跟 prompt cache 关系? 如果 user 点 [✨ 保存到 KOS] 频繁, 是否影响 sender_digest 1h TTL prefetch (PR-2f L1 hot block)? 需建模.
3. Auto-push (方案 3.2 B) 触发条件 "N 分钟无 activity" — N 取多少 (5 / 15 / 30)? 太短会过早 push 进行中对话, 太长 user 关 app 时丢.
4. 时间衰减 client-side rerank 跟 KOS bm25 score 怎么 combine — `final = bm25 * recency_factor` 还是 `final = bm25 + log(recency_factor)`? 测.
5. v3→v4 migration 跑 完 之 后 我 们 见 sessions 表 多 行 — 旧 backend_agent_page_id IS NULL 的 v1 row 怎么 cleanup? 留着无害 但 sidebar 显示 "n 个 session" 含没人记得的 ghost. 加 GC 任务 (delete 30d 未 access session)?

---

待 user review + 决策 D1-D6 后开 P1 ship PR.
