# AI Agent Harness + KOS Integration（从 CLAUDE.md 下沉）

> **前端 Custom AI chat panel** 的 multi-turn harness（用户在邮件 panel 里跟 LLM 对话时调工具），跟「LLM Agent（本地 LLM 接管 Notion Custom Agent）」那条单轮邮件分类路径不是同一个东西。

## AI Agent Harness（Sprint 19 起）

**状态**：✅ M1 已 ship 6 commits 到 `feat/agent-harness` 分支（2026-05-22/23, ~6261 LOC, 146 tests）；⚠️ **尚未 dogfood**，默认 `MAILAGENT_AGENT_HARNESS=0` 关着；满足 eval gate 后翻默认 flag 合 main。

**核心能力**（开 flag + Custom AI 后端）：
1. **Tool calling**：LLM 自驱调 10 个工具（7 read：email_search / get / body / list_thread / search_fulltext / get_ai_fields / attachment_list；3 write：email_flag / email_archive / email_draft_reply）
2. **Multi-turn loop**：harness 自循环 ≤ 8 iter / ≤ $0.5 per turn，end_turn 终止
3. **ConfirmToolDialog**：write tier 弹 dialog（preview = 只读 JSON / edit = 可编辑 textarea）→ 用户编辑值生效给 LLM 下轮看到
4. **跨邮件检索**：`email_search_fulltext` 接通后端 FTS5 `email_body_fts`
5. **Audit**：每个 tool_use 写 `chat_tool_call` 表（status / duration / user_edited_input）

**关键约束**：
- 仅 Custom AI 后端启用（Notion Agent CLI 不支持 tool_use 协议，gate 自动 fallback legacy single-turn）
- prompt cache 双 breakpoint（system 末 + tools 末）保护 95% 命中率
- 写操作必须 ConfirmToolDialog 确认（无 silent send）
- abort signal 触发时 cancelConfirmationsForSession 清队列（防 deadlock）

**关联文档**：
- 架构（ship 状态）：[`docs/architecture_agent_harness.md`](../architecture_agent_harness.md)
- 设计 ref（12 段工程级）：[`docs/agent-harness-design.md`](../agent-harness-design.md)
- 评测 gate（20 scenario）：[`docs/eval/email_scenarios.md`](../eval/email_scenarios.md)
- Dogfood handoff：[`frontend/SPRINT19-M1-HANDOFF.md`](../../frontend/SPRINT19-M1-HANDOFF.md)
- 决策记录：`~/.claude/plans/subagent-plan-lexical-moler.md`

## KOS Integration — M2 起点决策反转（2026-05-23）

原"自研 SQLite wiki"撤销，改为接入用户已有的 **Jarvis KOS v2**（gbrain fork on mac mini @ `kos.chenge.ink` + `127.0.0.1:7225`）。MailAgent 作为 KOS 的第 4 个消费者（Notion Knowledge Agent / OpenClaw / Feishu signal detector 已在用）。Producer：mail-sync 邮件 sync 完异步推 `/ingest`（path `mail/{internal_id}` + `scope:mail-agent` frontmatter）让 KOS 自动抽实体并入主图。Consumer：chat agent `kos_query` / `kos_digest` tool 调跨域知识。本地 FTS5 中文 wrapper + 附件文本化（PR-2a/2b）保留作 KOS 不可达时的 fallback。完整设计：[`docs/kos-integration-design.md`](../kos-integration-design.md) + M2 路线 [`frontend/SPRINT19-M2-PLAN.md`](../../frontend/SPRINT19-M2-PLAN.md)。

## M2 进度

- ✅ PR-2a (2026-05-23) — FTS5 中文 smart wrapper ship。后端 `smart_query_transform` + `search_email_bodies_smart` + 前端 `smartQueryTransform` 双份算法对齐。CLI / webhook handler / chat tool 全部默认 smart 模式。20 个后端单测 + 18 个前端单测全过。详见 [`v4-ssot-ops.md`](./v4-ssot-ops.md) Phase 3 段 / `src/repository/email_repository.py:smart_query_transform`。
- ✅ PR-2b (2026-05-23) — 附件文本化 + attachment FTS5 ship。新模块 `src/converter/attachment_text.py` 统一 PDF/docx/pptx/xlsx 抽取入口；DB v16 加 `email_attachment_text` + `email_attachment_fts` 表 + 3 triggers；EmailRepository 加 `enqueue/commit/get/list_pending/mark_failure/search_attachment_texts(_smart)` 方法；CLI `mailagent attachment search` / `mailagent attachment extract --pending --include-missing`；webhook handler `search_email_attachments`；前端 chat tool `email_search_attachments`。21 + 17 + 6 个新单测全过。详见 [`v4-ssot-ops.md`](./v4-ssot-ops.md) / `src/converter/attachment_text.py`。
- ✅ PR-2c (2026-05-23) — KOS MCP client (TS + Py 双份) ship。OAuth 2.1 client_credentials → 1h access_token (无 refresh, 401 重换) → POST /mcp 带 Bearer 调 JSON-RPC tools/call → SSE response 提取 `data: ` 行 JSON.parse → tool result `content[0].text` 二次 JSON.parse → caller-friendly value。`src/kos/client.py` (Python, ~300 LOC) + `frontend/src/electron/main/kos/client.ts` (TS, ~330 LOC) 算法 1:1 对齐。便捷方法 `health/call_tool/query/list_pages/put_page` + 11 个 stable error code (E_KOS_NOT_CONFIGURED / E_KOS_UNAUTHORIZED / E_KOS_RATE_LIMIT 等). 39 + 36 个新单测全过；实测真实 `https://kos.chenge.ink` health + query 跑通。详见 [`docs/kos-integration-design.md`](../kos-integration-design.md) §3。
- ✅ PR-2e (2026-05-23) — KOS consumer chat tools ship。两个 silent-tier read tool 接 PR-2c 的 KOSClient — `kos_query` (跨域 retrieval, 返 ranked page hits) + `kos_digest` (按 slug 拉 entity 档案, 内部走 `query(slug, limit=1, expand=true)` 取 top hit). category=meta, surface=webhook. KOSError 自动 surface 成 ok:false + stable code, LLM 自然 fallback 到 PR-2a `email_search_fulltext` / PR-2b `email_search_attachments` 本地 FTS5 路径. Gate by `MAILAGENT_KOS_CONSUMER_ENABLED=true` (默认 OFF, registerBuiltinTools 不 wire). 21 个新单测全过 (catalog + handler + flag gate). 详见 `frontend/src/electron/main/chat/tools/builtin/kos.ts`。
- ✅ PR-2d (2026-05-23) — KOS producer pipeline ship。`src/kos/producer.py` 新模块: `normalize_message_id_for_slug` (`<abc.123@host>` → `abc-123-host`) + `priority_at_or_above` (5-档 critical>urgent>important>normal>low) + `build_kos_page_payload` (YAML frontmatter 含 type/title/source_of_truth/tags/ai_priority + markdown body, 按 wire spec §7.1 mailagent 模板) + `push_email_to_kos` (fire-and-forget async, KOSError 仅 warning 不 raise, dry-run mode 支持). `new_watcher._maybe_trigger_kos_hook` 在 `_sync_single_email_v3` Notion sync 成功后 + LLM hook 之后调, 从 SQLite v14 主表读 `ai_priority`/`ai_action` + EmailRepository.get_body_markdown 取 markdown. 3 个 config setting: `MAILAGENT_KOS_INGEST_ENABLED` / `KOS_INGEST_PRIORITY_FLOOR` / `KOS_INGEST_DRY_RUN`. 43 个新单测全过. 默认 OFF 不动主同步; 启用时 KOS 不可达不阻塞主流程 (Mail.app + Notion 仍 SSoT). 详见 `src/kos/producer.py`。
- ✅ PR-2f (2026-05-23) — L1 hot block KOS sender digest 注入 ship。新模块 `frontend/src/electron/main/kos/slug.ts` (`senderToKosPeopleSlug('bob@acme.com')` → `people/bob-acme-com`) + `sender_digest_cache.ts` (in-memory cache + async `prefetchSenderDigest` + sync `getCachedSenderDigest`, 1h TTL, concurrent dedupe, KOSError silent cache null). `harness.ts:runHarness` 启动时 fire-and-forget `prefetchSenderDigest(emailContext.senderAddr)`. `custom_api.ts:buildSystemBlocks` **拆 system blocks 数组**: block 1 = STATIC + L1 hot block (sender digest, ≤ 4 KB 截断) 带 cache_control:ephemeral; block 2 = session-specific email context 无 cache_control — 跨邮件 chat session 都能命中 stable block cache (M1 之前 STATIC + ctx 单 block, 跨邮件必 miss). Gate by `MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=true` (默认 OFF). 28 个新单测全过 (slug + cache + buildSystemBlocks L1 paths). 详见 `frontend/src/electron/main/kos/sender_digest_cache.ts`。
- ✅ PR-2g (2026-05-23) — M2 dogfood 包 ship。`.env` 已写好 KOS 3 个 OAuth env (`KOS_MCP_BASE` / `KOS_OAUTH_CLIENT_ID` / `KOS_OAUTH_CLIENT_SECRET`) + 4 个 flag (`MAILAGENT_AGENT_HARNESS` / `MAILAGENT_KOS_INGEST_ENABLED` / `MAILAGENT_KOS_CONSUMER_ENABLED` / `MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED`) **全默认 false**, user 按 layer 启用. `scripts/dev/kos_smoke_test.sh` 4 步自动 verify (health / token / MCP query / Python KOSClient e2e). `docs/eval/m2-dogfood-checklist.md` 完整 layer-by-layer 启用 + 验收清单 (L1 KOS 连通 / L2 本地 fallback / L3 chat harness + KOS consumer / L4 producer). `docs/eval/email_scenarios.md` 加 S21-S25 共 5 个 KOS 专属 scenario (cross-source 检索 / L1 hot block / unreachable fallback / producer-consumer 闭环). 实测 smoke 4/4 OK. User 跑 dogfood 后翻 default flag 合 main.
