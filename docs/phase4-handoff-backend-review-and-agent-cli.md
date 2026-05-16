# Phase 4 → 后端 Review + Agent CLI Handoff

> **Mission**: 系统性 review 后端架构和代码，并基于现有能力设计/落地一套面向外部 agent 的标准 CLI。
> **前置文档**:
> - [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) — 架构总览（Phase 1-4 已全部 ship）
> - [`phase4-complete.md`](./phase4-complete.md) — Phase 4 ship 报告（最新一次主架构改动）
> - [`phase2-complete.md`](./phase2-complete.md) / [`phase3-complete.md`](./phase3-complete.md) — 前序 ship 报告
> - [`../CLAUDE.md`](../CLAUDE.md) — 项目总指南（Phase 推进表、运维、CLI 速查全部已更新到 Phase 4 灰度期）

---

## 1. TL;DR

后端 v4 SSoT 重构已经完成 4 个 Phase（数据层 + LLM/handler 切 SQLite + FTS5 + Notion 写入归一）。Phase 4 灰度期 `NOTION_READ_FROM_SQLITE=true` 已写入 `.env`，待 backfill 跑完 + derivatives 兜底后 `pm2 start mail-sync` 即生效。

新 session 的任务有两块：

1. **系统性 review** —— 后端架构 + 模块边界 + 代码质量 + 文档一致性
2. **设计并落地 agent-facing CLI** —— 把现有能力（散落在 `scripts/*.py` 中的 ~10 个真 CLI 工具 + `EmailRepository` / `NotionSync` 等 Python 接口）整合为一套**标准、统一、agent-friendly**的命令行入口，参考 Notion CLI 风格

后端 review 是设计 CLI 的前置 —— 没摸清模块边界就设计 CLI 容易切错颗粒度。两件事顺序串行。

---

## 2. 后端当前状态盘点

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│  数据层 (v4 SSoT)                                                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐ │
│  │ email_       │ │ email_body   │ │ email_       │ │ email_body │ │
│  │ metadata     │ │ (html + md)  │ │ attachment   │ │ _fts (FTS5)│ │
│  │ (internal_id │ │              │ │ (+ derived)  │ │            │ │
│  │  主键 v3)    │ │              │ │              │ │            │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └────────────┘ │
│  data/sync_store.db (DB_VERSION=5)                                  │
│  data/attachments/{internal_id}/{filename}                          │
└─────────────────────────────────────────────────────────────────────┘
           ▲                              │
           │ 写                           │ 读
           │                              ▼
┌──────────────────────┐    ┌─────────────────────────────────────────┐
│ 摄入路径             │    │ 下游消费者                              │
│ new_watcher          │    │ - LLM agent (processor)                 │
│ → AppleScriptArm     │    │ - handlers (fetch_mail_content / search │
│   .fetch_email_      │    │   _email_bodies)                        │
│   content_by_id      │    │ - reverse_sync (Notion → Mail.app)      │
│ → reader.parse       │    │ - NotionSync.create_email_page_*        │
│ → dual-write to      │    │ - project_progress (xlsx → Notion)      │
│   SQLite + Notion    │    │ - feishu notifications                  │
└──────────────────────┘    └─────────────────────────────────────────┘
```

### 2.2 模块布局（src/）

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `repository/` | **v4 SSoT 接口层** | `email_repository.py`（读写 + FTS5）, `attachment_store.py`, `storage_payload_builder.py` |
| `mail/` | 邮件摄入 + 状态机 | `new_watcher.py`（主循环）, `sync_store.py`（SQLite schema + 状态读写）, `applescript_arm.py`, `sqlite_radar.py`, `reverse_sync.py`, `reader.py`（MIME 解析）, `meeting_sync.py`, `icalendar_parser.py`, `health_check.py` |
| `notion/` | Notion 写入 | `client.py`（API 封装）, `sync.py`（create_email_page_v2 / from_sqlite + thread 关系） |
| `converter/` | 数据格式转换 | `html_converter.py` (HTML→blocks), `html_to_markdown.py`, `eml_generator.py`, `office_converter.py` (docx→PDF, xlsx→CSV), `notion_rich_text.py` |
| `events/` | Redis webhook 路由 | `redis_consumer.py`, `handlers.py`（flag_changed / ai_reviewed / fetch_mail_content / search_email_bodies / create_draft / etc.） |
| `llm_agent/` | 本地 LLM 接管 Notion AI 字段 | `runner.py`, `processor.py`, `client.py`, `notion_writer.py`, `prompt_loader.py`, `context_loader.py`, `digest_resolver.py`, `store.py`, `schema.py` |
| `notify/` | 飞书通知 | `feishu.py`（应用机器人 + 卡片）, `alert.py`（告警机器人） |
| `calendar_notion/` | 日历同步 | `sync.py`, `recurrence.py`, `description_parser.py` |
| `calendar/` | Calendar.app 读取（独立服务） | `reader.py`, `eventkit_watcher.py`, `applescript_reader.py` |
| `project_progress/` | 项目周报外挂 | `runner.py`, `detector.py`, `xlsx_parser.py`, `notion_sync.py`（**已用 Notion Markdown API，可作 T-01 样板**） |
| `stats_reporter.py` | 看板上报 | 单文件 |

入口：
- `main.py` — 邮件同步主服务（pm2 mail-sync）
- `calendar_main.py` — 独立日历同步服务（一般不用）
- `webhook-server/app.py` — Notion → Redis FastAPI（部署在远程 VPS）

### 2.3 接口层（Python API）

**`src/repository/EmailRepository`** —— 这是 v4 SSoT 的唯一标准入口，新 CLI 的所有"读"操作应优先走它：

```python
# 读
repo.get_body_html(internal_id) -> Optional[str]
repo.get_body_markdown(internal_id, max_chars=-1) -> Optional[str]
repo.get_body(internal_id) -> Optional[EmailBodyRecord]
repo.get_attachments(internal_id) -> list[AttachmentRecord]
repo.get_attachment_bytes(attachment_id) -> Optional[bytes]
repo.search_email_bodies(query, *, limit, mailbox, since_date, until_date) -> list[EmailSearchHit]

# 写
repo.commit_email_with_body(internal_id, body, attachments, message_id=...) -> dict[str, int]
repo.update_notion_links(internal_id, *, page_id, file_id_map, block_id_map) -> None
repo.delete_email_full(internal_id) -> None  # CASCADE 删 metadata + body + 本地文件
```

**`src/mail/sync_store.SyncStore`** —— 元数据读写（subject / sender / date / sync_status / retry_count 等），低层接口；agent CLI 设计时优先走 EmailRepository，需要时再补 sync_store 层 wrapper

**`src/notion/sync.NotionSync`** —— Notion 写入：
- `create_email_page_v2(email)` — 老入口（wrapper），灰度期默认走老路径
- `create_email_page_from_sqlite(internal_id, *, repo, sync_store, ...)` — Phase 4 新入口
- 反向同步辅助：`query_pages_for_reverse_sync`, `update_page_mail_sync_status`, `update_email_flags` 等

**`src/llm_agent/runner.LLMAgentRunner`** —— LLM 单封处理（`run_for_internal_id`）

**`src/project_progress/runner.ProjectProgressRunner`** —— 周报同步外挂

### 2.4 CLI 层现状（scripts/）

43 个脚本，杂糅 4 类，需要在 review 阶段重新归类：

#### 类 A：核心 CLI 工具（agent CLI 主要承载）
| 脚本 | 当前能力 | 入参 |
|---|---|---|
| `initial_sync.py` | 首次同步：fetch-cache / analyze / sync / all | `--action --inbox-count --sent-count --yes` |
| `manual_sync.py` | 手动同步单封 | `--message-id` |
| `run_llm_on_email.py` | LLM 单封跑 | `--internal-id --internal-ids --range --dry-run --force --no-overwrite --selftest` |
| `sync_project_progress.py` | 项目周报同步 | `--internal-id --all-history --limit --dry-run --force --sheets --backfill-project-start --first-migration-dry-run` |
| `resync_notion.py` | Notion 重传（v4 Phase 4） | `--internal-id --internal-ids --range --replace-existing --dry-run --max-failures --progress-every` |
| `backfill_email_body.py` | 历史邮件 body 回填到 SQLite | `--internal-ids --since-date --until-date --mailbox --limit --all --force --dry-run` |
| `backfill_derivatives.py` | Office 衍生附件补救（v4 Phase 4） | `--internal-id --dry-run --max-failures --progress-every` |
| `export_email_content.py` | 邮件正文导出 | （需读源码确认） |

#### 类 B：检查 / 调试工具
`check_*.py` （6 个）`cleanup_*.py` （3 个）`debug_*.py` （5 个）`inspect_*.py` （2 个） — 运维 ad-hoc，可以保留为 admin 子命令

#### 类 C：旧式测试脚本（非 pytest）
`test_*.py` （~10 个） — 早期 ad-hoc 验证，应迁进 `tests/` 或归档

#### 类 D：一次性迁移
`migrate_sync_store_v3.py`, `backfill_internal_id.py`, `backfill_notion_id.py` — 已完成历史使命，可归档进 `scripts/archive/`

#### 类 E：辅助 utilities
`html_clipboard.py`, `keep_alive.py`, `create_reply_draft.sh`, `toggle_keep_alive.sh`, `deploy-webhook.sh` — Shell / 子进程 helper，**不该是顶层命令**，但 agent 可能想触发其中一些

### 2.5 测试覆盖

```
tests/
├── events/          search_email_bodies + fetch_mail_content
├── llm_agent/       processor / schema / digest / md_to_rich_text / writer
├── mail/            meeting_sync_recurring / expansion_loop
├── notion/          create_from_sqlite (Phase 4) — 21 cases
├── project_progress/
└── repository/      email_repository (含 FTS5 search) + attachment_store
```

**295 passed**（截至 Phase 4）。**`src/mail/new_watcher.py`、`src/mail/sync_store.py`、`src/events/redis_consumer.py` 主路径单测覆盖薄弱** —— review 时应识别盲区。

### 2.6 不在本仓库 scope 的

- **Web 前端**（架构 doc Phase 5）—— 独立项目，本仓库只暴露 Python 接口 + CLI
- **Webhook server**（`webhook-server/`）—— 部署在远程 VPS，独立的 FastAPI，本次 review 可以瞥一眼但不在 CLI 设计范围
- **`src/calendar/`**（Calendar.app 独立服务）—— `calendar_main.py` 一般不跑，CLI 设计无需覆盖

---

## 3. Review Framework

### 3.1 架构层 review 角度

- **数据流**：摄入 → 双写 → 消费 → 反向同步的端到端路径是否清晰、错误传播是否正确
- **模块边界**：`mail/` vs `notion/` vs `repository/` 的职责分工有无重叠 / 漏洞
- **状态机**：`email_metadata.sync_status` 的 7 个状态（pending / fetched / synced / fetch_failed / failed / skipped / dead_letter）流转是否在所有路径上一致；retry 队列是否会漏邮件
- **并发与锁**：SQLite WAL 配置、AppleScript 串行假设、Redis consumer 并发安全
- **回退 / 灰度**：v4 灰度切换是否真的可以一键回滚（`NOTION_READ_FROM_SQLITE=false` + restart）；dual-write 失败的降级路径
- **接口契约**：EmailRepository 的 dataclass 字段是否覆盖前端需要的所有维度

### 3.2 代码层 review 角度

- **可测试性**：哪些路径无法独立单测（如 NotionSync 依赖真实 NotionClient）；DI 是否到位
- **错误处理**：哪些位置静默 fail（如 `convert_to_csv` return [] 不抛异常 —— 已经被本次发现）；告警是否覆盖
- **冗余 / 死代码**：v2 → v3 → v4 演进过程中遗留的兼容代码（如 `sync_store.py` 的旧表 ALTER）
- **命名一致性**：`internal_id` / `row_id` / `id` 三个概念在不同模块的使用
- **配置膨胀**：`src/config.py` 50+ 个 Field，是否有归并 / 默认值优化空间
- **文档与现状漂移**：`CLAUDE.md` 和代码的一致性（已有 Phase 4 更新，但其他陈年段落需要审）

### 3.3 输出格式建议

- 严重 issue 用 P0/P1/P2 标级
- 每条 issue 附文件:行号
- 区分"事实陈述"和"重构建议" —— 前者必须改，后者用户拍板
- review 不写代码，只输出 markdown 报告 + 必要 patch 建议

---

## 4. Agent CLI 设计目标

### 4.1 灵感来源

参考 [Notion CLI](https://developers.notion.com/reference) 的 REST 风格 + 现代 CLI 标杆（gh / kubectl / aws-cli）：
- 命令结构：`<tool> <resource> <action>` （如 `gh pr create`, `kubectl get pods`）
- 短描述（`--help` 一屏）+ 详细文档（`<cmd> --help` 完整）
- 输出双模：human-readable 默认；`--output json` / `--output yaml` 给 agent
- 全局 flag：`--output / -o`, `--quiet / -q`, `--verbose / -v`, `--config`, `--api-key`

### 4.2 功能性需求（Must）

| 资源 | 操作 | 对应现有接口 |
|---|---|---|
| `email` | `list` / `get` / `search` / `body` / `attachments` / `delete` | EmailRepository + sync_store |
| `email` | `resync` (重传 Notion) | scripts/resync_notion.py |
| `email` | `process-llm` (跑 LLM) | scripts/run_llm_on_email.py |
| `attachment` | `download` / `derive` (补 derivatives) | repo.get_attachment_bytes + backfill_derivatives |
| `search` | `query` (FTS5) | repo.search_email_bodies |
| `backfill` | `body` / `derivatives` | scripts/backfill_email_body / derivatives |
| `notion` | `create-page` / `update-flag` | NotionSync |
| `admin` | `stats` / `health` / `cleanup-deadletter` / `db-version` | sync_store + check_* / cleanup_* |
| `project-progress` | `sync` | scripts/sync_project_progress.py |

**不要**直接 1:1 映射 scripts/* —— 重新设计语义边界，让 agent 容易组合（如 `mailagent email get 53675 --include body,attachments --output json`）

### 4.3 非功能性需求

- **认证**：环境变量 `MAILAGENT_CLI_API_KEY`（与服务端配对的固定字符串），所有写操作要求；只读操作可豁免（用户态可控）。简单字符串比较，不上 OAuth 不搞 RBAC
- **配置**：默认读 `.env`；CLI 也支持 `--config /path/to/cli.toml` 覆盖
- **输出**：
  - 默认 human-readable（表格 / 摘要）
  - `--output json` → 结构化，stable schema（每个命令文档明确字段）
  - `--output yaml` → 同 JSON 内容
  - 错误统一 `{"status": "error", "code": "...", "message": "..."}` 出 stderr + 非零 exit
- **Help 体系**：
  - 顶层 `mailagent --help` 一屏（子命令分组）
  - `mailagent email --help` 列子操作
  - `mailagent email get --help` 完整参数 + examples
  - 关键 example 每个命令至少 1 个
- **可观测**：每条命令 stderr 输出 1 行 timing / counts（除非 `--quiet`）
- **退出码**：0 成功 / 1 业务失败 / 2 参数错误 / 4 认证失败 / 130 SIGINT

### 4.4 关键设计问题（让新 session 思考 + 决策）

1. **CLI 框架**：argparse（零依赖，啰嗦）vs `click`（流行，子命令自然）vs `typer`（type hints 友好）—— 推荐 `typer`
2. **单一入口 vs 多脚本**：建议单一入口 `mailagent` 命令（pip install -e . + entrypoint），保留 `scripts/*` 作为 legacy 兼容
3. **包结构**：新建 `src/cli/` 包含 `main.py`（typer 注册）+ `commands/` 子目录按资源拆分
4. **命名 vs gh 风格**：`mailagent email get` vs `mailagent get email` —— 选前者（资源名词在前更适合 agent autocomplete）
5. **批操作**：`--internal-ids` / `--range` 在 scripts 里已经在用，需要统一到 CLI 范式
6. **流式输出**：search / list 等大结果集是否走 ndjson 流式输出（agent 边读边处理）
7. **--dry-run 语义**：在哪些命令需要 / 默认行为是什么
8. **server mode**：CLI 是否同时提供 `mailagent serve --port 8080` 起一个本地 HTTP 给 agent 调用（不强求，但 agent 调 CLI 通常 fork 进程慢，HTTP 更合适）—— 这是开放问题，先 CLI 后考虑

---

## 5. 验证 / 入门命令

```bash
# 1. 当前状态确认
git log --oneline -5                        # 期望: dac9888 / 8e0c64e / c261242 / c175ac8 / 298a6dc
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"   # 期望: 5
source venv/bin/activate && pytest tests/ -q --tb=no | tail -3   # 期望: 295 passed

# 2. v4 关键数据规模
sqlite3 data/sync_store.db "
  SELECT 'metadata=' || (SELECT COUNT(*) FROM email_metadata)
    || ' body=' || (SELECT COUNT(*) FROM email_body)
    || ' fts=' || (SELECT COUNT(*) FROM email_body_fts)
    || ' attachments=' || (SELECT COUNT(*) FROM email_attachment)
    || ' derived=' || (SELECT COUNT(*) FROM email_attachment WHERE derived_from IS NOT NULL)
    || ' notion_file_id=' || (SELECT COUNT(*) FROM email_attachment WHERE notion_file_id IS NOT NULL)"

# 3. 灰度开关确认（应该 = true，等 backfill 完启 pm2）
grep NOTION_READ_FROM_SQLITE .env

# 4. backfill 进度
ps aux | grep backfill_email_body | grep -v grep

# 5. 服务状态（应 stopped，让 backfill 跑）
pm2 status mail-sync
```

---

## 6. 推荐 review + design 工作流

### 阶段 A：摸底（~2 小时）
- 读完本文档 + `architecture_v4_sqlite_ssot.md` + `phase4-complete.md`
- 跑 §5 验证命令确认环境
- `tree src/ scripts/ tests/ -L 2 -I __pycache__` 看布局

### 阶段 B：架构 review（~3-4 小时）
- 按 §3.1 角度逐项过；输出 markdown 报告 `docs/backend-review-2026-05.md`（或类似命名）
- 重点关注：dual-write 失败的真实降级、retry 队列状态机一致性、SQLite 并发、v4 灰度回滚路径

### 阶段 C：代码 review（~3-4 小时）
- 按 §3.2 角度过；先扫高复杂度文件（`new_watcher.py:945` / `notion/sync.py:1400` / `events/handlers.py:855` / `reader.py:700`）
- 用 `oh-my-claudecode:code-reviewer` agent 并行审多个文件，合并产出

### 阶段 D：CLI 设计 RFC（~1 天）
- 输出 `docs/agent-cli-rfc.md`：命令树、help 文案、输出 schema、auth 流程、兼容现有 scripts 的迁移路径
- 选定 CLI 框架（建议 typer）
- 给出 MVP 范围（前 5 个最高频命令）

### 阶段 E：CLI 落地（~2-3 天，可拆 PR）
- MVP：`mailagent email get / search / body / resync` + `auth` + `output json`
- 完整：覆盖 §4.2 所有命令
- 单测：每个命令至少 1 个 happy path + 1 个错误路径

---

## 7. 启动 prompt（新 session 复制粘贴）

```
继续 MailAgent 后端的系统性 review + Agent CLI 设计落地工作。
前置 handoff: docs/phase4-handoff-backend-review-and-agent-cli.md

按 §6 推荐工作流推进：先 §5 验证命令确认环境，再阶段 A 摸底，然后阶段 B 架构 review。
阶段 B 完成后停下来与我对齐 review 报告，再决定是否进入阶段 C 代码 review，
最后再启动阶段 D CLI 设计 RFC。

约束：
- 后端架构已是 v4 SSoT 4 个 Phase 全 ship 状态，灰度开关已在 .env 设 true，
  等 backfill 跑完用户会手动启 pm2，本 session **不做任何代码改动**直到 RFC 通过
- review 阶段输出严格区分"事实陈述"和"重构建议"，前者必须修，后者用户拍板
- CLI 设计参考 Notion CLI + gh + kubectl 范式，输出 RFC 不直接写代码
- 关键决策点先用 AskUserQuestion 对齐再推进
- 任何代码 review 工作可以 spawn 多个 code-reviewer agent 并行进行

如果在摸底阶段发现 handoff 文档有过时/错误信息，先 fix 文档再继续。
```

---

## 8. 已知 follow-up（与本任务相邻但不在 scope）

- **T-01**: Notion sync 迁 Markdown API（用 `body_markdown` 取代 children blocks）—— 样板 `src/project_progress/notion_sync.py`
- **T-06**: 附件 orphan cleanup CLI —— `email_attachment.notion_file_id` 已有数据可以扫
- **Phase 5**: Web / Electron 前端 —— 独立项目，但与本 session 的 agent CLI 设计可能在认证 / API schema 上有共享决策
- **backfill 进度**：`ps aux | grep backfill_email_body` 仍在跑（~15% → 100% 预计 6-8h）；review session 跑期间可继续，互不干扰
