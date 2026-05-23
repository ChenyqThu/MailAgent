# Sprint 19 M2 — KOS Integration Plan

> **状态**：📐 **M2 待启动**（M1 已 ship 7 commit + 文档收尾 commit）
> **方向**：撤销原 plan 的"自研 SQLite wiki"，改为接入用户已有的 **Jarvis KOS v2**（gbrain fork），MailAgent 作为第 4 个消费者
> **完整设计**：[`docs/kos-integration-design.md`](../docs/kos-integration-design.md)（含 architecture / client API / PR 拆分 / 安全 / fallback）

---

## 1. 接入目标

把当前 chat agent 从 *只能搜邮件* 升级为 *能问跨域知识库*：

- 用户问 "Bob 上次提的集成方案" → KOS 跨 sender 检索 + entity digest 注入
- 用户问 "Acme 项目最近怎么样" → KOS 跨邮件/手记/会议/Slack 全域召回
- 邮件自动丰富 KOS 图谱（Bob @ Acme 邮件流 → KOS 自动加 typed link，Notion 端的 Bob 档案得益）

---

## 2. 已确认决策

1. ✅ **Endpoint**：公网 `https://kos.chenge.ink` 主 + 本机 `http://127.0.0.1:7225` 兜底
2. ✅ **Ingest payload**：全文 markdown + frontmatter，让 KOS 自动抽实体
3. ✅ **Namespace**：page path 前缀 `mail/{internal_id}` + `scope: mail-agent` frontmatter；实体节点仍合并到全局（这是好事，跨域 entity 合一）
4. ⏳ **Auth env var**：用户已配 API key，下次 session 开始时告诉 client 读哪个 env var

---

## 3. PR 拆分（7 PR，~3-4 周日历）

| PR | 状态 | 范围 | LOC |
|---|---|---|---|
| PR-2a | ✅ ship 2026-05-23 | FTS5 中文 smart wrapper（CJK auto prefix + char-AND fallback + token-AND 融合）— 本地 fallback | +675 / -31 (含 fixture v14 fix + 38 新单测) |
| PR-2b | ⏳ pending | 附件文本化 (pypdf/python-docx/python-pptx/xlsx) + `email_attachment_fts` — 本地 fallback | ~700 |
| PR-2c | ⏳ blocked (KOS auth info) | **KOS client (TS + Py)** + .env config + health check + retry + circuit breaker | ~500 |
| PR-2d | ⏳ blocked (PR-2c) | **Producer**：mail-sync `_sync_single_email_v3` 完成后异步 `KOSClient.ingest`；priority floor; KOS 不可达不阻塞 | ~400 |
| PR-2e | ⏳ blocked (PR-2c) | **Consumer tools**：`kos_query` + `kos_digest` 加 `defaultToolRegistry`（silent tier, category=meta） | ~400 |
| PR-2f | ⏳ blocked (PR-2e) | L1 hot block 注入：chat 启动时按 sender 异步 `kos_digest(people/{slug})` → system block | ~300 |
| PR-2g | ⏳ blocked (PR-2f) | dogfood + eval：20 scenario + 5 KOS 专属新加；CLAUDE.md / arch doc 更新；翻 `MAILAGENT_KOS_ENABLED=1` 默认 | — |

**PR-2a ship 摘要**（commit 待确认）:
- 后端 `src/repository/email_repository.py`：`smart_query_transform` 模块级 fn + `EmailRepository.search_email_bodies_smart` method。算法 = 单字 CJK 加 `*`、多字 CJK 走 `(整 prefix OR 字符 AND fallback)`、多 token 间 AND、含 punct/operator 直接 raw passthrough。
- 前端 `frontend/src/electron/main/handlers/email.ts`：`smartQueryTransform` helper 跟 Python 端 1:1 算法对齐，`searchEmails` 加 `mode?: 'smart' | 'raw'` 参数（default smart）。
- 默认 smart 全面铺开：CLI `mailagent email search` (加 `--raw` 关掉)、webhook handler `handle_search_email_bodies` (加 `mode` 字段)、chat tool `email_search_fulltext`（LLM 自然语言直接传）。
- CLAUDE.md Phase 3 段更新算法说明 + 实测 CLI `产品` smart → `(产品* OR (产* AND 品*))` 命中 337 → 1640 (~5×) 召回提升、`产品评审` smart → 命中 2 封含 `产品评审会` token 邮件。
- 单测：后端 20 个 (`TestSmartQueryTransform` 14 个 pure fn + `TestSearchEmailBodiesSmart` 6 个集成测) + 前端 18 个 (`smartQueryTransform` 14 个 + `searchEmails smart mode` 4 个) 全过；464 个后端总测 + 74 个前端涉及面测试全绿。
- 顺手修了一个 M1 ship 时遗漏的 `frontend/tests/fixtures/sync-store-fixture.ts` v14 schema 缺 `ai_priority` / `ai_action` 列的 pre-existing 10 个测试 fail。

**保留**（M1 PR-1a 已建）：chat_db v3 `wiki_pages` / `wiki_fts` / `agent_memory_kv` 表保留**不主动写**，可能 M3 用作 KOS 不可达时的离线 cache。

---

## 4. 下次 session 启动 checklist

接手时按这个顺序：

1. **拿到 KOS auth env var 读法**（用户告诉 — `KOS_API_KEY` env var 是 plaintext bearer 还是别的 scheme？）
2. **SSH 看 KOS `/ingest` `/query` `/digest` route 签名**（不读 .env，只看 server 源码）：
   ```bash
   ssh chenyuanquan@100.98.144.119 'cd ~/Projects/jarvis-knowledge-os-v2 && \
     grep -nE "app\.(post|get).*['\''/]" server/kos-compat-api.ts | head -20'
   ```
3. **开 PR-2c**：先写 client + health check + dry-run mode，跑通连通性
4. **PR-2d**：producer 单元测覆盖（mock KOS / 真 mac mini 灰度环境）
5. **PR-2e / PR-2f**：consumer tools + L1 注入
6. **PR-2g**：跑 eval gate

---

## 5. M1 状态（参考，已 ship）

- 7 commit 在 `feat/agent-harness` 分支
- 146 tests pass / typecheck 双 side 干净
- `MAILAGENT_AGENT_HARNESS=0` 默认关，开 flag 才走多轮 harness
- **未 dogfood**：`frontend/SPRINT19-M1-HANDOFF.md` 详述跑法

M1 dogfood 跑出 ≥70% pass rate 后再启动 M2，或并行也行（M2 PR-2a/2b 跟 M1 流程独立，不需要 dogfood 验证完才能开）。

---

## 6. 关联文档

- KOS 集成设计（完整）：[`docs/kos-integration-design.md`](../docs/kos-integration-design.md)
- M1 ship 状态：[`docs/architecture_agent_harness.md`](../docs/architecture_agent_harness.md)
- M1 dogfood handoff：[`SPRINT19-M1-HANDOFF.md`](./SPRINT19-M1-HANDOFF.md)
- 决策记录：`~/.claude/plans/subagent-plan-lexical-moler.md`（M2 决策已更新）
