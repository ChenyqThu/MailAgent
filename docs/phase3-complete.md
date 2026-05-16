# Phase 3 完成报告（v4 SQLite SSoT — FTS5 全文搜索）

> **Phase 3 ship 日期**: 2026-05-15
> **范围**: P3-01 (FTS5 schema + trigger) · P3-02 (`EmailRepository.search_email_bodies`) · P3-03 (agent webhook `handle_search_email_bodies`) · P3-04 (28 个新单测) · P3-05 (文档)
> **前置文档**: [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) · [`phase2-complete.md`](./phase2-complete.md) · [`phase2-handoff-to-phase3.md`](./phase2-handoff-to-phase3.md)

---

## 1. TL;DR

`email_body.body_markdown` + `email_metadata.subject` + `email_metadata.sender` 三列已建 FTS5 索引；新 body 写入自动通过 trigger 同步入索引。

- **agent 工具**: `search_email_bodies` webhook → bm25 排序 + `<mark>` 高亮 snippet + mailbox / since_date / until_date 过滤
- **Schema 兼容**: DB_VERSION 4→5，启动时增量 reindex 已有 body 行；新邮件 trigger 自动维护
- **回退**: drop 掉 `email_body_fts` 虚表即可，不影响 body / metadata 数据
- **覆盖范围**: 当前 206 行已索引（与 backfill 进度同步）；backfill 跑完即覆盖全量 6131 封

---

## 2. 改动清单

### 2.1 新增 / 修改文件

| 文件 | 改动 |
|---|---|
| `src/mail/sync_store.py` | DB_VERSION 4→5，新增 `email_body_fts` 虚表 + 3 个 trigger + 首次 reindex |
| `src/repository/email_repository.py` | 新增 `EmailSearchHit` dataclass + `search_email_bodies()` 方法 |
| `src/repository/__init__.py` | 导出 `EmailSearchHit` |
| `src/events/handlers.py` | 新增 `handle_search_email_bodies` handler + search latency buffer + stats |
| `main.py` | 注册 `redis_consumer.on("search_email_bodies", ...)` |
| `tests/repository/test_email_repository.py` | +15 测试（search class） |
| `tests/events/test_search_email_bodies.py` | 新建 13 测试 |
| `docs/phase3-complete.md` | 本文档 |
| `CLAUDE.md` / `docs/architecture_v4_sqlite_ssot.md` | Phase 推进表更新 |

总单测：**274 passed**（Phase 2 246 + Phase 3 +28）。

### 2.2 FTS5 schema 细节

```sql
CREATE VIRTUAL TABLE email_body_fts USING fts5(
    body_markdown,
    subject,
    sender,
    tokenize='porter unicode61 remove_diacritics 2'
);
```

**关键决策**: 设计稿（handoff §5.1）用 `content=''`（contentless）想省空间，**但实测 contentless 模式下 `snippet()` 和直接 SELECT 列内容均返回空字符串** —— FTS 不存原文就没东西可高亮。

改成 contentful（FTS5 自带数据副本），代价：索引大小翻倍。实测 51 行 body ~680 KB → FTS ~700 KB；全量 6131 封估算 ~80 MB body + ~80 MB FTS = ~160 MB 总，完全可接受。

**Trigger（3 个）**:
- `email_body_fts_insert` AFTER INSERT ON `email_body` → 拼 subject/sender 写入 FTS
- `email_body_fts_delete` AFTER DELETE ON `email_body` → 同步删 FTS 行
- `email_body_fts_update` AFTER UPDATE ON `email_body` → DELETE + INSERT 重建 FTS 行

**首次启用 reindex**: `if current_version < 5` 时一次性 `INSERT ... SELECT ... WHERE NOT EXISTS`，幂等安全。

### 2.3 中文搜索行为说明（重要）

handoff §7.2 文档说法："`unicode61` 把中文当字符流 token，'产品' 实际拆成两个单字 token"。

**实测发现这个描述不准确**：SQLite 默认 unicode61（无 ICU 编译选项）实际把**连续 CJK 字符当一整个 token**。即 "本周产品评审" 会被索引为单个 token `本周产品评审`，搜 "产品" 命**不**中。

变通方案（**生效**）：
- 用前缀匹配：`search_email_bodies("产品*")` 能命中（FTS5 `*` 前缀通配符）
- 邮件正文里如果 "产品" 周围有 markdown 标记（`*`、`[`、空格、`/`），则会因为 unicode61 把这些非字母字符当分隔符而切出独立 token，此时不带 `*` 也能命中
- 这就是为什么生产 DB（来自真实邮件，含大量 markdown 链接 `[meet/...](...)`）能直接搜中文，但单测里纯连续中文必须带 `*`

未来升级路径（不在 Phase 3 scope）：
- 接入 `signal-fts5-tokenizer`（libsignal）或在 Python 侧 jieba 分词 + 写入预切的空白分隔字符串
- 改用 `tokenize='trigram'` —— 把所有 3-gram 当 token，中文/英文都能模糊搜，索引膨胀 3-5×

### 2.4 接口契约

**Webhook 请求**:
```jsonc
{
  "id": "<event-id>",
  "command": "search_email_bodies",
  "properties": {
    "query": "redis timeout AND retry",  // FTS5 语法，必填
    "limit": 50,                          // 可选，默认 50，cap 200
    "mailbox": "收件箱",                  // 可选
    "since_date": "2026-04-01",          // 可选，YYYY-MM-DD
    "until_date": "2026-05-15"           // 可选
  }
}
```

**Webhook 响应**:
```jsonc
{
  "status": "success",
  "query": "redis timeout AND retry",
  "total_hits": 2,
  "latency_ms": 7,
  "hits": [
    {
      "internal_id": 53451,
      "subject": "Wireless Product and Software Feature Schedule",
      "sender": "Kevin Berry <kevin.berry@tp-link.com>",
      "date_received": "2026-05-10T09:00:00+08:00",
      "mailbox": "收件箱",
      "snippet": "...<mark>redis</mark> connection <mark>timeout</mark>...",
      "rank": -1.76,
      "notion_page_id": "abc123",
      "notion_url": "https://www.notion.so/abc123"
    }
  ]
}
```

**Stats 新增**:
```jsonc
{
  "search_email_bodies": 42,
  "search_email_bodies_hits": 187,       // 累计返回的 hit 数
  "search_email_bodies_empty": 5,        // 0 hit 的请求数
  "search_email_bodies_error": 1,        // validation / repo 异常
  "search_email_bodies_p50_ms": 6,
  "search_email_bodies_p99_ms": 18
}
```

---

## 3. FTS5 query 语法速查（给 agent / 调用方）

| 写法 | 含义 |
|---|---|
| `meeting` | 单 token 精确匹配 |
| `"team meeting"` | 短语匹配 |
| `team AND meeting` | 必须都出现 |
| `team OR meeting` | 任一出现 |
| `meeting NOT canceled` | 包含 meeting 但不含 canceled |
| `meet*` | 前缀匹配（meeting / meets / meet 都命中） |
| `产品*` | **中文必须用前缀通配符**（见 §2.3） |
| `redis NEAR(timeout)` | 两个 term 距离 < 默认 10 token |

非法语法（未闭合引号、孤立 NOT 等）由 repo 层吞掉返回 `[]` + warning，不抛异常。

---

## 4. 生产验证

### 4.1 当前数据
```
db_version=5
email_body=206  email_body_fts=206  (与 backfill 同步)
trigger: email_body_fts_insert, email_body_fts_delete, email_body_fts_update
```

### 4.2 真实邮件检索（手测）
```sql
SELECT rowid, subject, snippet(...) FROM email_body_fts WHERE email_body_fts MATCH 'meeting' ORDER BY bm25(...) LIMIT 3
→
53451 | Wireless Product and Software Feature Schedule | ...Teams <mark>meeting</mark>**...
53508 | 【6.4】Omada Controller v6.4需求确认 | ...com/<mark>meet</mark>/48695047399123...
53433 | 【AIO】安防线待与事业部沟通 Bug 对齐 | ...com/<mark>meet</mark>/42545032063362...
```

bm25 ~ -1.76（越小越相关），snippet 高亮工作正常。

### 4.3 部署提示
当前 `pm2 mail-sync` 因 backfill 在跑被停掉。Phase 3 代码已落，等 backfill 完成后 `pm2 start mail-sync` 即激活 webhook。

无需额外环境变量 —— 只要 `REDIS_EVENTS_ENABLED=true` + `BODY_DUAL_WRITE_ENABLED=true`（都已是默认）就工作。

---

## 5. 风险 / 限制

| 风险 | 应对 |
|---|---|
| 中文精确搜索受 unicode61 限制 | 文档明示用 `*` 前缀；未来 jieba 升级（不在 scope） |
| FTS 索引和 body 写入不一致 | trigger 在同事务内执行，原子提交；若有遗漏可手动 `INSERT ... SELECT ... WHERE NOT EXISTS` 补 |
| Backfill 期间 trigger overhead | 实测每封 +3-5ms，对总 backfill 时长影响 < 5% |
| Agent 误传超大 limit | handler cap 到 200 |
| FTS5 query 语法错误打挂调用方 | repo + handler 双层 try/except，语法错误返回空结果 + warning |

**回退**:
```sql
-- 即时停用 FTS（不影响 body / metadata）
DROP TABLE email_body_fts;
DROP TRIGGER email_body_fts_insert;
DROP TRIGGER email_body_fts_delete;
DROP TRIGGER email_body_fts_update;
```
下次启动 sync_store 会自动重建（db_version 检查），所以如果想**永久**禁用还得改 sync_store.py。

---

## 6. Phase 3 余下任务

### 已 ship ✅
- [x] P3-01 FTS5 schema + 3 trigger + 首次 reindex
- [x] P3-02 `EmailRepository.search_email_bodies` + `EmailSearchHit`
- [x] P3-03 `handle_search_email_bodies` webhook + main.py 注册 + stats
- [x] P3-04 28 个新单测全绿（274 全套）
- [x] P3-05 文档（本文 + CLAUDE.md + 架构文档）

### Deferred / 后续
- **P3-06 中文分词升级** —— 不在 Phase 3 scope；先看实际使用反馈再决定走 jieba 还是 trigram
- **dashboard 端 search UI** —— webhook-server 仓库的事，stats 已上报，等需要时拉
- **T-02 backfill 完成度** —— 当前 ~3% (206/6131)，跑完后 search 自动覆盖全量
- **Phase 4** Notion uploader 改读 SQLite，架构归一

### Phase 4 入口（下一步）
backfill 完成 + 真实使用 search 一段时间后再决定是否进 Phase 4。Phase 4 改动面更大（Notion sync 改架构），建议先观察 Phase 3 稳定性。

---

## 7. 监控查询

```bash
# FTS 索引覆盖率
sqlite3 data/sync_store.db "
  SELECT
    (SELECT COUNT(*) FROM email_body) AS bodies,
    (SELECT COUNT(*) FROM email_body_fts) AS fts_rows,
    (SELECT COUNT(*) FROM email_body) - (SELECT COUNT(*) FROM email_body_fts) AS gap"

# search 调用统计 + P99
curl -s "https://mailagent.chenge.ink/api/stats/latest" | jq '.handlers | {
  total: .search_email_bodies,
  hits: .search_email_bodies_hits,
  empty: .search_email_bodies_empty,
  error: .search_email_bodies_error,
  p50: .search_email_bodies_p50_ms,
  p99: .search_email_bodies_p99_ms
}'

# 手动跑一次 search（绕过 Redis）
python -c "
from src.repository import EmailRepository
hits = EmailRepository('data/sync_store.db').search_email_bodies('meeting', limit=5)
for h in hits:
    print(f'{h.internal_id} bm25={h.rank:.2f} | {h.subject[:50]}')
    print(f'  {h.snippet[:120]}')
"
```

---

## 8. 关键文件索引

### Phase 3 主入口
- `src/mail/sync_store.py:95-99, 332-410` — DB_VERSION 5 + FTS5 schema + trigger + reindex
- `src/repository/email_repository.py:88-101, 222-313` — `EmailSearchHit` + `search_email_bodies`
- `src/events/handlers.py:46-105, 745-855` — `handle_search_email_bodies` + stats
- `main.py:92-95` — webhook 注册

### 测试
- `tests/repository/test_email_repository.py` — `TestSearchEmailBodies` class（15 case）
- `tests/events/test_search_email_bodies.py` — 13 case
