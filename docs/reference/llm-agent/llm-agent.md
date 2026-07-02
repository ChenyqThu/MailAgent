# LLM Agent — 本地 LLM 接管 Notion Custom Agent（从 CLAUDE.md 下沉）

> 邮件同步到 Notion 后，由本地 LLM（Anthropic Messages 兼容网关）填 11 个 AI 分类/分析字段 + Daily Digests relation，取代原来 Notion Custom Agent（Email Agent）。**默认关闭**。
> 启用清单另见 [`docs/LLM_AGENT_SETUP.md`](LLM_AGENT_SETUP.md)。
>
> 注意：这跟「AI Agent Harness（前端 Custom AI 多轮 agent）」不是同一个东西 —— 那是前端 chat panel 的 multi-turn harness，见 [`docs/architecture_agent_harness.md`](architecture_agent_harness.md)。

## ⚠️ 启用前必做（否则会双跑撞车）

本地 LLM + Notion Custom Agent 都盯同一张页面，必须让其中一边退出，**二选一**：

- **方案 A（推荐）**：在 Notion Email Agent Instructions 页面最前面加一句硬约束「仅处理 `Processing Status = 未处理` 的邮件；其他状态一律跳过」。本地 LLM 处理完后状态是 `AI Reviewed` / `已完成`，Notion Agent 读到就自动跳过。
- **方案 B**：直接禁用 automation（Notion Email Inbox → Automations → Email Agent → Disable）。

没做这一步直接开本地 LLM，两边会同时写同一张页面 → `Processing Status` 被改两次 → webhook 重复触发 → 飞书卡片 + Mail.app 标旗重复跑两次。

## 启用步骤

1. `.env` 里改开关：
   ```
   LLM_AGENT_ENABLED=true
   LLM_API_KEY=cr_xxx              # https://crs.chenge.ink 签发的 key
   LLM_CONTEXT_PAGE_ID=xxx         # Email Agent Context 页面 ID（可选但强烈建议）
   LLM_DAILY_DIGEST_DATABASE_ID=xxx  # 可选，不填则跳过 Daily Digests relation
   # LLM_MODEL=claude-sonnet-4-6                       # 可选，主模型默认 Sonnet 4.6
   # LLM_FALLBACK_MODELS=gpt-5.4,claude-opus-4-7       # 可选，主模型挂掉时按序兜底
   ```
2. Notion 那边暂停 Email Agent（见上）。
3. `pm2 restart mail-sync` 并确认日志 `[llm-agent] enabled (model=... base=...)`。

## 模型 fallback 链（自动兜底，避免上游单点 outage）

`AnthropicClient.classify` 按 `[LLM_MODEL] + LLM_FALLBACK_MODELS` 顺序调用，第一个成功即返回；任一抛 `LLMCallError`（含 HTTP 5xx / "No available accounts in group" / 协议错 / 超时）就 warning 切下一个。最后一个还失败才上抛由 store 走重试队列。

默认链：`claude-sonnet-4-6 → gpt-5.4 → claude-opus-4-7`。

| 模型 | 协议 | 端点 | 备注 |
|---|---|---|---|
| `claude-*` | Anthropic Messages | `/v1/messages` + native `tool_use` | 走 `anthropic.AsyncAnthropic`，cache_control 生效 |
| `gpt-*` / `gemini-*` / `codex-*` | OpenAI Chat Completions | `/v1/chat/completions` 流式 + `tool_calls` | 走 `httpx` 直连，CRS 强制 `stream=true`；OpenAI 协议无 cache_control，命中数始终 0 |

`client.py:_is_openai_proto` 按模型名前缀路由，前缀写死在常量 `_OPENAI_PROTO_PREFIXES`。CRS 上 `owned_by != anthropic` 的模型都走这条路；要新加路由前缀就改这个常量。

注意：
- 切到 OpenAI 协议时 cache 自动失效（不同协议 + 不同 model = 不同 prefix hash），那次调用算 cache miss；fallback 是兜底而非常态，命中率指标不会被它持续拖累。
- Fallback warning 在 `pm2 logs mail-sync` 里以 `[llm] model=X failed, falling back to Y: ...` 出现，可作为上游异常告警信号。
- 想完全禁用 fallback：`LLM_FALLBACK_MODELS=`（空串），或行级 `fallback_models_json=[]`（见下节）。

## 预处理 Agent 化（v1.1.0）—— 行级模型 / 文档 / prompt 配置

AI 邮件预处理在前端是 Agents 页的一张 Custom Agent 卡片（`report_agent` 表 `type='preprocess'` 行，id=`email_preprocess_agent`，DB v27 seed）。开关仍走全局 env `LLM_AGENT_ENABLED`；运行时叠加配置存行级列，读侧 `src/llm_agent/preprocess_config.py` 在**每封邮件处理时重读**该行 → 卡片 PATCH 保存即生效，不需重启服务。

- **模型行级覆写**：`report_agent.model` 列，空 = 跟随全局 `LLM_MODEL`。chat gateway 的默认模型与预处理自此解耦（改 chat 默认模型不再影响分类）。
- **fallback 行级三态**（`fallback_models_json` 列，DB v29）：`NULL` = 跟随全局 `LLM_FALLBACK_MODELS`；`[]` = 显式不设兜底；`[m, ...]` = 预处理专用 fallback 链。
- **model_chain 构造**（`processor.py:process_email`）：model 空 + fallback NULL（双跟随）→ 传 `None` 走 `classify` 内建全局链，行为字节级同拆分前；任一被定制 → 显式链 `[行模型 or LLM_MODEL, *有效 fallback]`。
- **身份文档勾选**（`context_docs_json` 列，DB v27）：`NULL` = 默认注入 soul+user（`build_task_identity_context` 默认）；`[]` = 不注入任何身份文档。**persona 覆写层已随 v1.1.0 移除** —— 身份/偏好统一由 Standing Context 文档注入，旧行残留的 `prompt` 列值一律忽略。
- **分类 prompt 查看**：只读端点 `GET /api/llm/preprocess-prompts` 返回收/发件箱 mailbox prompt 全文（前端卡片抽屉内 inbox/sent tab 查看器）。改 prompt 仍走文件（`prompts/*.md` 或 `LLM_INBOX_PROMPT_PATH` / `LLM_SENT_PROMPT_PATH`），端点不提供写。
- **PATCH 面**：`src/reports/store.py` 的 `_AGENT_PATCH_FIELDS` 白名单含 `model` / `context_docs_json` / `fallback_models_json`。

## 模块结构

```
src/llm_agent/
  schema.py          EMAIL_TOOL_SCHEMA（Anthropic tool JSON schema） + enums（匹配 Notion DB）
  client.py          AsyncAnthropic 封装（含 User-Agent 绕 Cloudflare 1010）
  prompt_loader.py   mtime-aware 热重载收/发件箱 prompt .md
  preprocess_config.py 读 report_agent preprocess 行（行级 model/context_docs/fallback，每封邮件重读）
  context_loader.py  加载 Email Agent Context markdown（30min TTL）
  md_to_rich_text.py Markdown → Notion rich_text JSON（bold/italic/strike/code/link + 换行）
  digest_resolver.py 日期 → Daily Digest page_id（5min 缓存）
  notion_writer.py   AILabels → pages.update 多字段写入
  processor.py       核心入口：拼 system+user → LLM tool_use → AILabels
  store.py           llm_processing SQLite 表（retry 队列 + cost/latency 记录）
  runner.py          端到端封装（sync_store → arm fetch → parse → LLM → Notion write）
  task_extractor.py  灵动岛 F3/F5: 邮件 → 日程库 task fields（LLM 单次 tool_use 决策 title/time/日程类型/优先级；as_meeting 模式抽会议时间）。`mailagent notion create-task` CLI 调
src/cli/commands/llm.py       CLI（`mailagent llm {selftest,run,retry-failed,stats,compare-paths}`；PR-6 起取代旧 scripts/run_llm_on_email.py）
prompts/
  email_inbox.md     收件箱判定规则（mailbox-specific）
  email_sent.md     发件箱 follow-up 判定规则
  README.md         定制说明
```

## 挂钩位置

- 正向钩子：`src/mail/new_watcher.py:_sync_single_email_v3` 中项目周报 hook 之后派发 `self._maybe_trigger_llm_hook(email_obj, internal_id, page_id)` → `asyncio.create_task` fire-and-forget，不阻塞主同步。
- 重试队列：`_poll_cycle` 每轮调 `_process_llm_retry_queue()`，处理 `llm_processing.status='failed'` 且 `next_retry_at <= now` 的邮件（指数退避 1min/5min/15min/1h/2h）。

## 失败兜底

- 单次失败：`retry_count++`，指数退避重试。
- 达到 `LLM_MAX_RETRIES` 次（默认 3）：`status='gave_up'`，**不写任何 AI 字段**、**不动 Processing Status**（保持"未处理"）、飞书告警（warning 级别），由 Notion Custom Agent 自然接手（如果它还活着，否则字段空着手动补）。

## Processing Status 路由（关键语义）

- 收件箱 LLM 处理完 → `Processing Status='AI Reviewed'` → Notion webhook 触发 `handle_ai_reviewed` → Mail.app 标旗 + 飞书卡片 + Processing Status→'已同步'。
- 发件箱 LLM 处理完 → `Processing Status='已完成'`（按原 Email Agent Instructions §发件箱生命周期字面：发件箱不经 AI Reviewed）→ Notion webhook 触发 `handle_completed` → 移除 Mail.app 旗标（发件箱本来就极少标旗，无害）。

## CLI

```bash
# 网关健康检查（不烧 token 做真实 Notion 写入）
mailagent llm selftest

# 单封干跑（看 LLM 输出 + 待写 properties 但不写 Notion）
mailagent llm run 51793 --dry-run

# 单封实跑（覆盖已有字段）
mailagent llm run 51793 --force

# 范围重跑（保留用户已手改的非空字段）
mailagent llm run --internal-ids 51000-51100 --force --no-overwrite
```

## 监控

```bash
# 处理状态分布
sqlite3 data/sync_store.db "SELECT status, COUNT(*) FROM llm_processing GROUP BY status"

# 看最近失败
sqlite3 data/sync_store.db "
  SELECT internal_id, status, retry_count, substr(last_error,1,60)
    FROM llm_processing WHERE status IN ('failed','gave_up')
  ORDER BY updated_at DESC LIMIT 10"

# cost 审计（cache hit 用 cache_read_input_tokens，按 0.1x input 定价）
sqlite3 data/sync_store.db "
  SELECT SUM(input_tokens) as in_tok, SUM(output_tokens) as out_tok,
         SUM(cache_creation_input_tokens) as cache_write,
         SUM(cache_read_input_tokens) as cache_read,
         AVG(latency_ms) as avg_ms, COUNT(*) as n
    FROM llm_processing WHERE status='success'"

# 最近 20 封的缓存命中情况
sqlite3 data/sync_store.db "
  SELECT internal_id, input_tokens, cache_creation_input_tokens, cache_read_input_tokens
    FROM llm_processing WHERE status='success'
    ORDER BY updated_at DESC LIMIT 20"

# 近 7 天命中率（cache_read>0 的请求占比）
sqlite3 data/sync_store.db "
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN cache_read_input_tokens > 0 THEN 1 ELSE 0 END) AS hits,
    ROUND(100.0 * SUM(CASE WHEN cache_read_input_tokens > 0 THEN 1 ELSE 0 END)
          / COUNT(*), 1) AS hit_pct
  FROM llm_processing
  WHERE status='success' AND updated_at > strftime('%s','now','-7 day')"
```

## Prompt Caching（CRS 已落地，默认开启）

- 位置：`src/llm_agent/processor.py:_build_system` 在 system 最后一个稳定 block 加 1 个 `cache_control`，前缀覆盖 tools + header + ctx + mailbox prompt + final constraints。单断点 + 最大前缀 = 稳过 Sonnet 4.6 的 2048 tokens 最低阈值。
- 策略：永远带 `cache_control`，由服务端自动判 hit/miss/write。客户端无状态，不做时机判断（prefix 变了 → 自动 miss 重建；TTL 过期 → 自动 write；都不需要我们操心）。
- TTL：默认 `LLM_CACHE_TTL=1h`（`src/config.py`）。`client.py` 无条件发 `anthropic-beta: extended-cache-ttl-2025-04-11` header，所以 1h TTL 在 CRS 和原生 Anthropic 两条路都生效。想强制 5m 就 `LLM_CACHE_TTL=5m`；留空则让网关决定（CRS 默认 1h、原生 Anthropic 默认 5m，会漂，不推荐）。
- 不伪装 Claude Code：CRS 对非 CC 请求会把 system 迁移到 messages，但会保留 cache_control；只要每次调用 prefix 内容一致，迁移后的 hash 依然稳定、命中照常。伪装（`User-Agent: claude-cli/x.y.z` + `x-app: cli`）在 CRS 检测规则变化时容易碎，**不推荐**。
- 关开关：`LLM_CACHE_ENABLED=false`（非 Anthropic 协议、或定位 cache 相关故障时）。
- 命中验证：对同一 internal_id 跑两次 `mailagent llm run X --force`，第 2 次的 `cache_read_input_tokens` 应 > 0、`cache_creation_input_tokens` 应 = 0（prefix 没变、TTL 没过）。
- 典型收益（Sonnet 4.6，100 封/工作日集中到达）：input 约 4400 uncached + 2500 cached；5m cache 命中率 ~75%，月省 ~$13；1h cache ~95%，月省 ~$17。

## LLM payload vs Notion 页面字段一致性

本地 LLM 替代 Notion Custom Agent 后，两者拿到的邮件上下文语义上等价，字节级不一致——对邮件分类任务这个差异不重要。对照：

| 字段 | `processor._build_user` payload（给 LLM） | Notion page properties（给 Notion Agent） |
|---|---|---|
| 主题 / 发件人 / To / CC / Date / 邮箱 / Thread / Read/Flagged/HasAttachments | ✅ 全部传 | ✅ 全部写 |
| 正文 | `body_text`：plaintext，HTML 剥除，截到 `LLM_BODY_MAX_CHARS`（默认 12000 字符） | HTML → Notion blocks（保留格式、内联图） |
| 附件 | `attachments: [filename, ...]` 只文件名 | 真实文件上传（docx→PDF、xlsx→CSV） |
| 日期 | `date_iso` + `date_utc8_date`（LLM 方便做 digest 归类） | `Date`（完整时间） |
| Message ID / Parent Item / internal_id | ❌ 不传（分类不需要，也避免 LLM 瞎填 relation） | ✅ 写 |

判断依据：邮件分类看 subject / sender / body 语义 + thread / action 等 metadata，不看排版或附件内容；HTML 格式和附件内容对 Notion Custom Agent 的分类决策也没额外价值。所以 **`_build_user` 不需要跟 Notion properties 字节对齐**——判断质量取决于 prompt（`prompts/*.md`）和 context（Email Agent Context 页面），不取决于 payload 形状。

如果未来想让 LLM 看附件内容（比如对合同邮件做深度分析），需要另开一条 pipeline：把 docx→PDF 后上传到 Anthropic Files API、在 `_build_user` 里加 `file_id`，这不在当前 scope 内。

## 多人配置

- 每人 fork/clone 后改自己的 `.env`：`LLM_API_KEY` / `LLM_CONTEXT_PAGE_ID` / `LLM_INBOX_PROMPT_PATH` / `LLM_SENT_PROMPT_PATH`。
- 默认 `prompts/*.md` 跟仓库走；想用自己私人版本就复制成 `prompts/myuser_inbox.md` 等（不会提交），再改 `.env` 指过去。
- Notion email database schema 全员一致；要改 schema（加/改 select option）→ 同步改 `src/llm_agent/schema.py` 并跑 `pytest tests/llm_agent/test_schema.py`。

## 常见问题

- **网关 HTTP 403 + Cloudflare `error code: 1010`**：缺 `User-Agent`。`src/llm_agent/client.py` 默认会加 `MailAgent-LLM/0.1`，绕过即可。
- **HTTP 500 `No available Claude accounts support the requested model`**：网关上游 Claude 账户暂时 exhausted；通常稍等几分钟会恢复。
- **`cache_read_input_tokens` 一直是 0**：
  - 第 1 次调用本来就该是 `cache_creation`，命中要看第 2 次起；
  - 如果第 2 次还是 0：看 context 是否刚被刷新（30min TTL）、prompt .md 是否被改过（mtime 变了）、mailbox 是否和上次不同——这几项任意变都会让 prefix hash 变化、cache 自然 miss；
  - 都没变还是 0：先看缓存段是否低于模型最低阈值（Sonnet 4.6 = 2048 tokens，Opus 4.7 = 4096）——低于阈值会被服务端静默跳过；
  - 最后才怀疑网关或账户不支持。`LLM_CACHE_ENABLED=false` 可临时关掉断点定位问题。

## 测试

```bash
pytest tests/llm_agent/ -v
```

覆盖：`md_to_rich_text` / `schema` enum 一致性 / `digest_resolver` mock 查询 / `processor` sanitizer + 时区 / `writer._build_props` 各种字段组合。全部 mock 不调网关不烧钱。
