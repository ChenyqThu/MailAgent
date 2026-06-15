# Phase 2 → Phase 3 Handoff（v4 SQLite SSoT 重构）

> **Phase 2 上线日期**: 2026-05-15
> **Phase 2 状态**: ✅ 全部完成（代码、单测、文档、生产服务、helper 脚本）
> **Phase 3 状态**: ⏳ 待办（下一 session 入口点）
> **前置文档**:
> - [`docs/phase2-complete.md`](./phase2-complete.md) — Phase 2 完整 ship 报告
> - [`docs/architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) — 完整架构（FTS5 schema 在 §3.3）
> - [`docs/phase1-handoff-to-phase2.md`](./phase1-handoff-to-phase2.md) — 上一阶段 handoff（已 obsolete，仅供参考）

---

## 1. TL;DR

Phase 2 已把下游消费者（LLM / `handle_fetch_mail_content`）从 AppleScript 切到 SQLite SSoT，~250× latency 提升。

**Phase 3 要做**：在 SQLite 上建 FTS5 全文索引 + 暴露 `search_email_bodies` 工具给 agent / 外部系统。

---

## 2. Phase 3 可以马上开始吗？

**可以。FTS5 实施不依赖 backfill 完成度。**

理由：
- FTS5 是 schema + index 改造，跟数据量无关
- 当前已有 51 封 body 行（53677 dual-write + 50 封 backfill 验证）足够开发 + 测试
- T-02 全量 backfill 是数据填充工作，可以**并行**做（只需在跑 backfill 期间临时 pm2 stop mail-sync，不影响 Phase 3 代码工作）
- FTS5 trigger 会自动 index 新加入的 body 行，无需重复 reindex（backfill 写入即被 trigger）

**唯一限制**：search 结果在 backfill 完成前只覆盖已 dual-written 的邮件（当前 51 封 + 新邮件）；想全量搜索就等 backfill 完。

---

## 3. Phase 2 落地清单（已 ship）

### 3.1 提交记录
```
aab383a docs(v4): Phase 2 ship report + ops guide
1b5091c feat(scripts): LLM path regression + email body backfill helpers (v4 Phase 2)
da6175c feat(consumers): LLM + handlers read SQLite SSoT (v4 Phase 2)
```

7 个本地 commits（Phase 1 4 + Phase 2 3）**未 push**，按用户偏好决定是否 push。

### 3.2 接口变更（Phase 3 可消费）
- `LLMProcessor(repo: Optional[EmailRepository])` —— 注入式 SQLite 读
- `EventHandlers(email_repo: Optional[EmailRepository])` —— 注入式 SQLite 读
- `handle_fetch_mail_content` 响应加 `source: "sqlite-cache" | "applescript-fresh"` + `latency_ms`
- `EventHandlers.get_stats()` 加 `fetch_mail_content_sqlite_p50/p99_ms` + `applescript_p50/p99_ms`
- `LLM_PREFER_SQLITE_BODY` env 开关（默认 true）

### 3.3 测试覆盖
- 246 全套 pytest passed（Phase 1 43 + Phase 2 +25 + 历史）

---

## 4. 当前生产服务状态

```bash
# 进程状态
pm2 list
# mail-sync online, uptime > 0

# v4 + Phase 2 加载
pm2 logs mail-sync --lines 50 --nostream | grep -E "v4|llm-agent"
# 期望:
#   [v4] email body dual-write enabled (SQLite SSoT)
#   [llm-agent] enabled (model=gpt-5.5 base=https://crs.chenge.ink/api)

# 数据量
sqlite3 data/sync_store.db "
  SELECT 'metadata=' || (SELECT COUNT(*) FROM email_metadata)
    || ' body=' || (SELECT COUNT(*) FROM email_body)
    || ' attachments=' || (SELECT COUNT(*) FROM email_attachment)
    || ' need_backfill=' || (
      SELECT COUNT(*) FROM email_metadata m
        LEFT JOIN email_body b ON m.internal_id = b.internal_id
       WHERE m.sync_status='synced' AND m.notion_page_id IS NOT NULL AND b.internal_id IS NULL
    )"
```

最后一次验证（2026-05-15 22:38）：metadata=8492 body=51 attachments=136 need_backfill=6081

---

## 5. Phase 3 工作清单

### 5.1 P3-01 — FTS5 schema + trigger

**入口**: `src/mail/sync_store.py`，与 v4 表 DDL 并列加 FTS5 表

```sql
-- 设计稿（docs/architecture_v4_sqlite_ssot.md §3.3）
CREATE VIRTUAL TABLE IF NOT EXISTS email_body_fts USING fts5(
    body_markdown,
    subject,
    sender,
    content='',  -- contentless: 自己存数据，不挂到 email_body
    tokenize='porter unicode61 remove_diacritics 2'
);
```

**⚠️ tokenizer 注意**：
- `porter` 是英文 stemming，对中文无效（不分词）
- `unicode61` 把每个 unicode codepoint 当 token，中文实际上变成单字搜索（"产品管理"→搜 "产" "品" "管" "理" 都能命中）
- 实测可用，但相关性不如分词器
- 升级路径：换 `signal-fts5-tokenizer` (libsignal) 或 `simple` + jieba 预处理（Phase 4 之后）

**Trigger**（让 `email_body` 写入自动同步 FTS）：
```sql
CREATE TRIGGER IF NOT EXISTS email_body_fts_insert AFTER INSERT ON email_body BEGIN
    INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
    SELECT NEW.internal_id, NEW.body_markdown,
           (SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id),
           (SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id);
END;

CREATE TRIGGER IF NOT EXISTS email_body_fts_delete AFTER DELETE ON email_body BEGIN
    DELETE FROM email_body_fts WHERE rowid = OLD.internal_id;
END;

CREATE TRIGGER IF NOT EXISTS email_body_fts_update AFTER UPDATE ON email_body BEGIN
    DELETE FROM email_body_fts WHERE rowid = OLD.internal_id;
    INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
    SELECT NEW.internal_id, NEW.body_markdown,
           (SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id),
           (SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id);
END;
```

**首次启用 reindex**（把现存 51 行 body 推入 FTS）：
```sql
INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
SELECT b.internal_id, b.body_markdown, m.subject, m.sender
  FROM email_body b
  JOIN email_metadata m ON m.internal_id = b.internal_id;
```

**DB_VERSION bump**: 4 → 5。新 session 启动时 sync_store 自动执行 ALTER + 建 trigger + reindex（不阻塞、增量友好）。

### 5.2 P3-02 — `EmailRepository.search_email_bodies`

**入口**: `src/repository/email_repository.py`，加新方法

```python
@dataclass
class EmailSearchHit:
    internal_id: int
    subject: str
    sender: str
    snippet: str          # FTS5 snippet() 高亮片段
    rank: float           # bm25 score（越小越相关）

def search_email_bodies(
    self,
    query: str,
    *,
    limit: int = 50,
    mailbox: Optional[str] = None,   # 可选过滤
    since_date: Optional[str] = None,
    until_date: Optional[str] = None,
) -> list[EmailSearchHit]:
    """FTS5 全文搜索；query 支持 FTS5 语法（短语 / AND/OR/NOT / NEAR）"""
```

实现要点：
- 用 `bm25(email_body_fts)` 排序
- `snippet(email_body_fts, 0, '<mark>', '</mark>', '...', 64)` 取高亮片段
- JOIN `email_metadata` 拿 subject/sender/date/mailbox 做二次过滤

### 5.3 P3-03 — Agent 工具 `handle_search_email_bodies`

**入口**: `src/events/handlers.py`，加新 webhook handler

```python
async def handle_search_email_bodies(self, event: Dict):
    """全文搜索邮件正文（FTS5）.

    请求:
        query: str (必填)
        limit: int (默认 50, 最大 200)
        mailbox: str (可选)
        since_date / until_date: str (可选, YYYY-MM-DD)

    返回:
        hits: list[{internal_id, subject, sender, snippet, rank, notion_url}]
    """
```

在 `main.py` 注册：
```python
self.redis_consumer.on("search_email_bodies", handlers.handle_search_email_bodies)
```

### 5.4 P3-04 — Notion automation hook（可选）

让 Notion 端可以通过 webhook 触发搜索（参考 query_mail / fetch_mail_content 路径）。
具体看用户需求；可以 defer 到 Phase 3 后。

### 5.5 工时估计
Phase 3 整体 0.5-1 天（FTS5 schema 简单、search 接口直白、测试可控）。

---

## 6. Phase 3 关键文件入口（速查）

### 要改的
- `src/mail/sync_store.py:95-329` — DB_VERSION 5 + FTS5 表 + trigger DDL + 首次 reindex
- `src/repository/email_repository.py` — `search_email_bodies` + `EmailSearchHit` dataclass
- `src/events/handlers.py` — `handle_search_email_bodies` + stats counter
- `main.py:84-90` — Redis consumer 注册 `search_email_bodies`
- `tests/repository/test_email_repository.py` — search 单测（hit/empty/mailbox 过滤/特殊字符）
- `tests/events/test_search_email_bodies.py`（新建）— webhook handler 单测
- `CLAUDE.md` Phase 推进表更新 + 加 search 章节

### 不要动的（Phase 1+2 已就位）
- `src/repository/storage_payload_builder.py` — Email→payload 转换
- `src/repository/attachment_store.py` — 附件 IO
- `src/llm_agent/processor.py` — LLM 路径已优化
- `src/events/handlers.py:526-700` — fetch_mail_content 已是 SQLite-first

---

## 7. 注意事项 / 风险

### 7.1 FTS5 与 PRAGMA foreign_keys 兼容性
- FTS5 是 virtual table，不参与 FK 约束
- 但 trigger 里 SELECT email_metadata 时如果 metadata 行被删（CASCADE 触发删 body），trigger 应该在 body 删除前完成 —— SQLite 保证同事务内顺序

### 7.2 中文搜索质量
- `unicode61` 把中文当字符流 token，"产品" 实际拆成两个单字 token
- 相关性会差一些，但**实际可用**（用户测试 51 封时验证）
- 想要好质量分词需要装 jieba + 自定义 tokenizer C 扩展（**不在 Phase 3 scope**）

### 7.3 索引大小
- FTS5 contentless 索引大约是原文 50-100% 大小
- 当前 body 总 size ≈ 51 * 13.4K avg = ~680 KB → FTS 索引 ~340-680 KB
- 全量 6131 封后估算：~80 MB body markdown → ~40-80 MB FTS 索引
- 完全可接受

### 7.4 backfill 期间的并发
- backfill 跑时 `INSERT INTO email_body` 会触发 FTS trigger 同步写 `email_body_fts`
- 每封多 ~3-5ms trigger overhead，对总 backfill 时长影响 < 5%
- 不需要"先关 trigger 跑 backfill 再开 trigger" 这种特殊路径

---

## 8. Phase 3 完成后的下一步

Phase 3 ship 后：
1. **dashboard 端加 search UI**（可选，webhook-server 仓库）
2. **Phase 4** — Notion uploader 改读 SQLite，架构归一
3. **T-01** Notion sync 迁 Markdown API
4. **T-02** backfill 跑完后 search 自动覆盖全量

---

## 9. 新 session 启动验证命令

```bash
# 1. 在 Phase 2 完成状态确认
git log --oneline -7
# 期望看到 aab383a docs(v4): Phase 2 ship report + ops guide

# 2. 数据状态
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"  # 期望 4（Phase 3 会 bump 到 5）

# 3. 单测全绿
source venv/bin/activate && pytest tests/ -q
# 期望 246 passed

# 4. 服务在线
pm2 status mail-sync   # online
```

---

> **新 session 接手指令**：
>
> "继续 Phase 3 的实施工作。前置 handoff 文档：`docs/phase2-handoff-to-phase3.md`。先按 §9 跑验证命令确认环境，然后从 §5 P3-01 开始实施。Phase 3 不依赖 backfill 完成度，可立即开工。"
