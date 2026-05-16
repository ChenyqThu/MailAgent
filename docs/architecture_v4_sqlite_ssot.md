# MailAgent v4 架构：SQLite 升级为邮件 SSoT

> **状态**: ✅ **Phase 1 + 2 + 3 已上线 2026-05-15**；✅ **Phase 4 已 ship 2026-05-16（灰度期，默认 `NOTION_READ_FROM_SQLITE=false`）**；Phase 5 待办
> **输入**: `docs/web-handoff-body-storage.md` (MailAgent-Web hand off)
> **目标**: 把 Notion 是 body 唯一持久化处反转为 SQLite 是数据中心、Notion 是镜像
> **范围**: Phase 1 双写 MVP（done）；Phase 2-5 后续推进；Notion Markdown API 迁移列独立 TODO
> **Phase 交接**: 见 [`docs/phase1-handoff-to-phase2.md`](./phase1-handoff-to-phase2.md)
> **关联 plan**: `~/.claude/plans/ultrathink-handoff-imperative-naur.md`

---

## 1. 背景与目标

**当前痛点（来自 web 端 handoff §1）**：
- 邮件正文 (body) 只活在两处：**内存中的 Email 对象**（仅单次 sync 生命周期）和 **Notion blocks**
- SQLite 仅 22 列 metadata，零 body / 零 attachment
- Web 端读 body 必须走 Notion API，P50 1-3s、P95 5s+
- LLM processor / `handle_fetch_mail_content` / 反向同步等下游各拉各的（有的重抽 AppleScript，有的剥 HTML，有的从 Notion property 读），没统一入口
- 未来 RAG / LLM wiki / Electron "AI Outlook" 前端需要本地结构化 body 与 FTS5

**目标**：
1. 邮件正文（HTML 原始 + Markdown 加工版）作为一等公民进 SQLite，Markdown 兼任 LLM 输入 / RAG / FTS5 索引源
2. 附件 + 内联图片元数据进表，二进制落本地稳定路径（不再 `/tmp`）
3. 提供稳定的 `EmailRepository` 接口层 —— Web/Agent/反向同步/LLM/Notion uploader 一律走这里
4. **Notion 退化为镜像**：所有内容从 SQLite 同步而来，反向同步也走 SQLite 中转
5. 现有功能 "可跑、不大改" —— 分 5 个 Phase 渐进推进
6. Phase 1 不实现 Electron 前端，但接口层架构必须就位

---

## 2. 数据流（目标态）

```
                 ┌──────────────────┐
                 │   Mail.app       │
                 └────────┬─────────┘
                          │ AppleScript fetch_email_content_by_id
                          ▼
                ┌──────────────────────────────────┐
                │ reader._extract_from_source +    │
                │ build_storage_payloads()          │
                └────────┬─────────────────────────┘
                         │ BodyPayload + AttachmentPayload[]
                         ▼
        ┌────────────────────────────────────────┐
        │  SQLite TRANSACTION (sync_store.db)    │
        │  ├── email_metadata  (现有)            │
        │  ├── email_body      (新 v4)           │
        │  ├── email_attachment (新 v4)          │
        │  └── email_body_fts  (Phase 3 启用)    │
        └─────────┬───────────────┬──────────────┘
                  │               │
            落盘附件文件          │  (DB commit)
                  │               │
                  ▼               ▼
   data/attachments/{int_id}/  ┌─────────────────────────────┐
                               │   EmailRepository（接口层） │
                               └────────┬────────────────────┘
                                        │
        ┌───────────────────┬───────────┴────────────┬────────────────────┐
        ▼                   ▼                        ▼                    ▼
 Notion Uploader     LLM Processor           handle_fetch_mail      Web / Electron
 (Phase 4 切)        (Phase 2 切)             content (Phase 2 切)  (Phase 5 起)
        │
        ▼
    Notion page (镜像)
```

**数据流不变量**：
- **写路径单一**：`build_storage_payloads()` → 事务 commit 三张表 + 落盘附件
- **读路径单一**：所有消费者通过 `EmailRepository` 读
- **附件二进制不入 SQLite**：仅存元数据 + 本地相对路径
- **Notion 是镜像，不是数据源**：反向同步也从 SQLite 取

---

## 3. Schema 设计

### 3.1 `email_body`（新表 v4）
```sql
CREATE TABLE email_body (
    internal_id        INTEGER PRIMARY KEY,
    message_id         TEXT,                    -- 冗余便于 join；NULL when AppleScript 尚未成功
    body_html          TEXT,                    -- 原始 HTML（cid: 已重写为 attachments/{id}/file 相对路径）
    body_markdown      TEXT,                    -- HTML→Markdown (markdownify)，LLM / RAG / FTS5 / Notion 镜像通用
    body_format        TEXT,                    -- 'html' | 'text-only' | 'empty'
    body_size_bytes    INTEGER,                 -- markdown 长度
    has_inline_images  INTEGER DEFAULT 0,
    raw_mime_sha256    TEXT,                    -- raw MIME 哈希，校验/去重；不存正文
    fetched_at         REAL NOT NULL,
    fetched_source     TEXT NOT NULL,           -- 'applescript' | 'emlx' | 'notion-backfill'
    schema_version     INTEGER DEFAULT 1,
    FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
);
CREATE INDEX idx_email_body_message_id ON email_body(message_id) WHERE message_id IS NOT NULL;
```

**设计要点**：
- **HTML + Markdown 双存**：HTML 是原始数据可重新转 Markdown；Markdown 接近 plain text 又保留结构，LLM 省 30-60% token，FTS5 直接索引（unicode61 tokenizer 把 `*`、`[`、`#` 当分隔符，语法符号不影响检索）
- **不存 raw MIME**：handoff 论证 6-7 万封 body ~5-6 GB；raw MIME 再叠 ~10 GB 是 15+ GB；仅 sha256 用于完整性校验
- **独立表**：列表查询无需读 body；可单独 vacuum；FTS5 一行接入

### 3.2 `email_attachment`（新表 v4）
```sql
CREATE TABLE email_attachment (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    internal_id        INTEGER NOT NULL,
    content_id         TEXT,                    -- MIME CID（inline image）
    filename           TEXT NOT NULL,
    content_type       TEXT,
    size_bytes         INTEGER,
    is_inline          INTEGER DEFAULT 0,
    local_path         TEXT,                    -- 相对项目根：data/attachments/{int_id}/{filename}
    sha256             TEXT,
    derived_from       INTEGER,                 -- 自指 FK：转换产物指向原附件 id；NULL = 原始
    derived_format     TEXT,                    -- 'pdf' | 'csv'（仅 derived 行有值）
    notion_file_id     TEXT,                    -- Phase 4 起回写
    notion_block_id    TEXT,
    created_at         REAL NOT NULL,
    schema_version     INTEGER DEFAULT 1,
    FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE,
    FOREIGN KEY (derived_from) REFERENCES email_attachment(id) ON DELETE SET NULL
);
CREATE INDEX idx_email_attachment_internal ON email_attachment(internal_id);
CREATE INDEX idx_email_attachment_cid ON email_attachment(content_id) WHERE content_id IS NOT NULL;
CREATE INDEX idx_email_attachment_sha256 ON email_attachment(sha256) WHERE sha256 IS NOT NULL;
```

**`derived_from` 语义**：
- 一封邮件 `report.docx` 附件 + 它的 `report.pdf` 转换产物 = 两行
- pdf 行的 `derived_from` 指向 docx 行的 `id`，`derived_format='pdf'`
- 删除原附件 → derived SET NULL（防孤儿）

### 3.3 `email_body_fts`（✅ Phase 3 已上线 2026-05-15）
```sql
CREATE VIRTUAL TABLE email_body_fts USING fts5(
    body_markdown,
    subject, sender,
    tokenize='porter unicode61 remove_diacritics 2'
);
-- contentful 模式（实测 content='' contentless 模式下 snippet() 取不到原文）
-- rowid = internal_id；3 个 trigger 在 email_body insert/update/delete 时自动维护

CREATE TRIGGER email_body_fts_insert AFTER INSERT ON email_body BEGIN
    INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
    SELECT NEW.internal_id, COALESCE(NEW.body_markdown, ''),
           COALESCE((SELECT subject FROM email_metadata WHERE internal_id=NEW.internal_id), ''),
           COALESCE((SELECT sender  FROM email_metadata WHERE internal_id=NEW.internal_id), '');
END;
-- _delete / _update trigger 同源对称（详见 src/mail/sync_store.py）
```

**中文搜索限制**：SQLite 默认 unicode61 把连续 CJK 当**一个**大 token（不拆字），精确搜 "产品" 命不中 token "本周产品评审"。必须用前缀通配 `产品*`。生产邮件因含 markdown 标记（`*` / `[` / 空格）会自动切出独立中文 token，多数情况能直接搜中文。未来 jieba / signal-fts5-tokenizer 升级见 [`docs/phase3-complete.md`](./phase3-complete.md) §2.3。

### 3.4 附件本地存储

**路径**：`<project_root>/data/attachments/{internal_id}/{sanitized_filename}`

- 与 `sync_store.db` 同 `data/` 目录便于统一备份
- `internal_id` 稳定主键
- 不污染用户 `~/Library`，便于多机迁移

**inline image HTML 重写**：解析时把 `<img src="cid:xxx">` 改为 `<img src="attachments/{internal_id}/{filename}">`，存入 `body_html`。Web/Electron 前端通过本地 HTTP 路由 resolve 该相对路径（Phase 5）。

**清理**：DB CASCADE DELETE → 后台 CLI 扫 orphan 目录清理（T-06，按月跑）。

---

## 4. 接口层：`EmailRepository`

文件：`src/repository/email_repository.py`

```python
class EmailRepository:
    """SQLite SSoT 读写入口（v4 架构）."""

    # ===== Read =====
    get_body_html(internal_id) -> str | None
    get_body_markdown(internal_id, max_chars=-1) -> str | None
    get_body(internal_id) -> EmailBodyRecord | None
    get_attachments(internal_id) -> list[AttachmentRecord]
    get_attachment_bytes(attachment_id) -> bytes | None

    # ===== Search (Phase 3) =====
    search_email_bodies(query, *, limit=50, mailbox=None,
                        since_date=None, until_date=None) -> list[EmailSearchHit]

    # ===== Write =====
    commit_email_with_body(internal_id, body, attachments, *, message_id=None) -> dict[str, int]
    update_notion_links(internal_id, *, page_id=None, file_id_map=None, block_id_map=None)
    delete_email_full(internal_id)   # 删 metadata 触发 CASCADE，并清理 data/attachments/
```

**事务保证**：`commit_email_with_body` 是单事务，metadata + body + attachments 原子提交；落盘失败会回滚并清理已写文件。

**配套模块**：
- `src/repository/attachment_store.py`：本地文件落盘 / 读取 / 路径生成 / orphan 扫描
- `src/repository/storage_payload_builder.py`：从 `Email` 对象 + raw MIME 源构造 BodyPayload + AttachmentPayload list（含 HTML cid 重写 + Markdown 转换）
- `src/converter/html_to_markdown.py`：HTML → Markdown 统一入口（markdownify 主路径）

---

## 5. 改造路径（5 个 Phase）

### Phase 1：双写 MVP（✅ **已上线 2026-05-15**）

**目标**：新邮件 sync 时把 body + attachments 也落 SQLite，旧 Notion 同步路径保持原样。Web 端马上能切表读取，立即享受 1000× 加速。

**改动清单见 §7 实施进度。验证状态**：43/43 单测通过、`db_version=4`、生产服务已加载 `[v4] email body dual-write enabled`。

### Phase 2：接口归一
- `llm_agent/processor._plaintext_body` → 读 `repo.get_body_markdown`
- `events/handlers.handle_fetch_mail_content` → 优先读 SQLite，fallback AppleScript
- Web 端 `/api/emails/:id/body` 切 SQLite（web repo 单独 PR）

### Phase 3：FTS5 + RAG（✅ 已上线 2026-05-15）
- ✅ `email_body_fts` 虚表 + 3 个 trigger（自动维护，无需独立 backfill 脚本）
- ✅ DB_VERSION 4→5 启动时一次性 reindex 已有 body 行（幂等）
- ✅ `EmailRepository.search_email_bodies()` + `EmailSearchHit` dataclass
- ✅ `handle_search_email_bodies` Redis webhook handler，main.py 注册
- ✅ 274/274 单测全绿
- 详见 [`docs/phase3-complete.md`](./phase3-complete.md)

### Phase 4：Notion uploader 切换为下游消费者（✅ 已 ship 2026-05-16，灰度期）
- ✅ `notion/sync.create_email_page_from_sqlite(internal_id, repo, sync_store)` 新入口 + 5 个 SQLite 辅助方法
- ✅ `create_email_page_v2` 改为 wrapper，灰度开关 `NOTION_READ_FROM_SQLITE`（默认 `false` 保守）
- ✅ `scripts/resync_notion.py` 基于 SQLite 重传，不再依赖 AppleScript
- ✅ `scripts/backfill_derivatives.py` 单独补 Office 衍生附件（PDF/CSV）漏跑
- ✅ 上传完成回写 `email_attachment.notion_file_id`，为 T-06 / 反向同步打底
- ✅ 295/295 单测全绿；3 封灰度切换实测 OK
- 详见 [`docs/phase4-complete.md`](./phase4-complete.md)

### Phase 5：Web / Electron（未来）
- 接口契约已就位，独立项目推进

---

## 6. Backfill 策略

**默认仅新邮件双写**。历史邮件按需触发（Phase 1+）：

```bash
# 从 Mail.app 重抽（推荐，完整）—— 6-7 万封约 17 小时
python3 scripts/backfill_body.py --source=applescript --since=2026-01-01 --limit=1000

# 从 Notion 反向 backfill（快但有损，历史只读邮件可用）
python3 scripts/backfill_body.py --source=notion --internal-ids=1000-5000
```

Backfill 写 `fetched_source` 区分来源，UI 可提示 "该邮件 body 来自 Notion 重建，富文本可能有损"。

---

## 7. 实施进度

### Phase 1 ✅ 全部完成（2026-05-15）
| 任务 | 文件 | 说明 |
|---|---|---|
| **P1-01** schema v4 | `src/mail/sync_store.py` (DB_VERSION→4, line 95-97) | 新建 `email_body` + `email_attachment` + 索引，foreign_keys PRAGMA |
| **P1-02/03** Repository | `src/repository/` 整个目录 | `EmailRepository` + `AttachmentStore` + `build_storage_payloads` + `html_to_markdown` |
| **P1-04** parse_for_storage | `src/repository/storage_payload_builder.py` | 复用 reader._extract_from_source；不改 reader 自身 |
| **P1-05** html_to_markdown | `src/converter/html_to_markdown.py` | markdownify 主路径，html2text fallback |
| **P1-06/07** new_watcher 双写 | `src/mail/new_watcher.py` (_sync_single_email_v3, _process_retry_queue) | 在 Notion sync 前调 _maybe_dual_write_body，失败仅 warning |
| **P1-08** 配置项 | `src/config.py`, `.env.example`, `requirements.txt` | `BODY_DUAL_WRITE_ENABLED`、`ATTACHMENT_STORAGE_DIR`、markdownify 依赖 |
| **P1-09** 单测 | `tests/repository/` | 43 个 case，覆盖事务/CASCADE/derived_from/cid 重写/Markdown 转换/落盘失败回滚 |
| **P1-10** e2e | pm2 restart + 启动日志 | `[v4] email body dual-write enabled` 已在 pid=8752 生效 |
| **P1-11** CLAUDE.md | `CLAUDE.md` | v4 章节已加（schema 速查 / EmailRepository 用法 / Phase 推进） |
| **P1-12** Office 转换链路 | `src/models.py` (Attachment +2 字段), `src/notion/sync.py` (_convert_office_attachments) | derived_from_filename / derived_format 贯通到 email_attachment 表 |
| **P1-13** inline image cid 重写 | `src/repository/storage_payload_builder.py` (_rewrite_cid_to_local) | `<img src="cid:xxx">` → `attachments/{int_id}/{filename}` |

### Phase 2 待办（下一 session 入口点）
见 [`docs/phase1-handoff-to-phase2.md`](./phase1-handoff-to-phase2.md)：
- P2-01 `llm_agent/processor._plaintext_body` → `repo.get_body_markdown`
- P2-02 `events/handlers.handle_fetch_mail_content` → 优先读 SQLite
- P2-03 跑 1000 封对比 LLM 输出
- P2-04 监控 P99 latency 指标
- P2-05 web 端 PR 切 SQLite

---

## 8. 关键代码索引

### 8.1 新增模块
- `src/repository/__init__.py` — 导出层
- `src/repository/attachment_store.py` — 本地附件文件 IO
- `src/repository/email_repository.py` — SSoT 读写接口
- `src/repository/storage_payload_builder.py` — Email → SQLite payload 转换
- `src/converter/html_to_markdown.py` — HTML→Markdown 统一入口
- `docs/architecture_v4_sqlite_ssot.md` — 本文档

### 8.2 修改文件
- `src/mail/sync_store.py:95-97, 269-329, 113-118` — DB_VERSION=4 + 两表 schema + FK PRAGMA
- `src/mail/new_watcher.py:38-44, 114-130, 380-393, 450-490, 733-740` — repo 初始化 + 双写 + retry 双写
- `src/models.py:14-15` — Attachment 加 derived_from_filename / derived_format
- `src/notion/sync.py:114-126` — _convert_office_attachments 填 derived 字段
- `src/config.py:32-39` — body_dual_write_enabled / attachment_storage_dir
- `.env.example` 尾部 — 新配置示例
- `requirements.txt` 尾部 — markdownify 依赖

### 8.3 参考样板（不动）
- `src/project_progress/notion_sync.py:1-210` — Notion Markdown API 用法（T-01 复用）
- `scripts/migrate_sync_store_v3.py` — migration 脚本模式

---

## 9. 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `BODY_DUAL_WRITE_ENABLED` | `true` | 是否双写邮件正文 + 附件到 SQLite。失败仅 warning，不阻断主流程 |
| `ATTACHMENT_STORAGE_DIR` | `data/attachments` | 附件本地落盘目录（按 internal_id 分子目录） |

**回滚开关**：`BODY_DUAL_WRITE_ENABLED=false` 即可停掉所有 v4 双写动作，恢复 v3 行为。

---

## 10. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| body 双写失败导致主流程挂 | Notion sync 也挂 | 双写在 try/except 内，失败仅 warning |
| DB 膨胀至 10+ GB | vacuum 慢、备份大 | 独立 `email_body` 表 + 后续 `PRAGMA auto_vacuum=INCREMENTAL` (T-05)；FTS5 单独 vacuum |
| 附件目录 orphan 累积 | 磁盘浪费 | 独立 cleanup CLI (T-06)，不在主流程 |
| Phase 2 切换后 LLM markdown 与 plaintext 差异 | 分类结果漂移 | 保留正则路径作 fallback；切换前 1000 封对比 |
| Notion Markdown API 迁移延期 | 无影响 | 独立 TODO，Phase 1-4 都不依赖 |

**回滚路径**：
- Phase 1：`BODY_DUAL_WRITE_ENABLED=false`
- Phase 2：消费者保留旧路径作 fallback
- Phase 3：drop FTS5 表不影响 body
- Phase 4：旧 wrapper 回滚

---

## 11. TODO（独立、低优先级）

- **T-01** Notion Markdown API 迁移：邮件 sync 从 `blocks.children.append` 切到 `PATCH /pages/{id}/markdown`，复用 `src/project_progress/notion_sync.py` 样板。**额外收益**：Phase 4 后 SQLite 已有 `body_markdown`，直接 PATCH 现成字段
- **T-02** Backfill 历史邮件
- **T-03** emlx 直读通道（加速 backfill 100x）
- **T-04** `processing_status` / `web_action_at` 两个未文档化字段补 CLAUDE.md
- **T-05** `PRAGMA auto_vacuum=INCREMENTAL` 启用 + 月度 vacuum CLI
- **T-06** 附件目录 orphan 清理 CLI

---

## 12. 验证方式

| 检查 | 命令 | 期望 |
|---|---|---|
| Schema migration 不破坏老 DB | `python3 -c "from src.mail.sync_store import SyncStore; SyncStore('data/sync_store.db')"` | `db_version=4`，新表存在 |
| 新邮件双写 | `pm2 restart mail-sync` → 等 5-10 min → `sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body WHERE fetched_at > strftime('%s','now','-10 min')"` | 与同期 `email_metadata` 增量一致 |
| 附件落盘 | `ls -la data/attachments/<recent_internal_id>/` | 文件存在、大小合理 |
| Notion sync 不挂 | `pm2 logs mail-sync --lines 50` | 无 error |
| 单元测试 | `pytest tests/repository/ -v` | 全绿 |

---

> 本文档随实施推进持续更新。问题 / 建议 → 在主仓库开 issue 或直接 PR。
