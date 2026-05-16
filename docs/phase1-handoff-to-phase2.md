# Phase 1 → Phase 2 Handoff（v4 SQLite SSoT 重构）

> **Phase 1 上线日期**: 2026-05-15
> **Phase 1 状态**: ✅ 全部完成（代码、单测、文档、生产服务）
> **Phase 2 状态**: ⏳ 待办（下一 session 入口点）
> **前置文档**:
> - [`docs/architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) — 完整架构设计
> - [`docs/web-handoff-body-storage.md`](./web-handoff-body-storage.md) — web 端原始 hand off
> - `~/.claude/plans/ultrathink-handoff-imperative-naur.md` — 立项 plan

---

## 1. TL;DR

**Phase 1 把 Notion 是 body 唯一持久化处反转为 SQLite 是数据中心**：

- 新邮件 sync 时把正文（HTML 原始 + Markdown 加工版）+ 附件元数据**双写**到 SQLite
- 附件二进制落 `data/attachments/{internal_id}/`（不再 `/tmp`）
- 现有 Notion 同步链路**保持原样**，零侵入（双写失败仅 warning）
- `EmailRepository` 接口层已就位，Web/Agent/未来 Phase 2-4 消费者都从这里读

**Phase 2 要做**：把下游消费者（LLM processor / `handle_fetch_mail_content`）从"再调 AppleScript 重抽 / 正则剥 HTML"切换为"直接读 SQLite"。

---

## 2. Phase 1 落地清单

### 2.1 新增模块
```
src/repository/
├── __init__.py                       # 导出层
├── attachment_store.py               # 附件本地文件 IO（落盘/读盘/sanitize/orphan）
├── email_repository.py               # SQLite SSoT 读写接口（事务保证）
└── storage_payload_builder.py        # Email 对象 → SQLite payload 转换（cid 重写 + MD 转换）

src/converter/
└── html_to_markdown.py               # HTML→Markdown 统一入口（markdownify 主路径）

tests/repository/
├── __init__.py
├── test_attachment_store.py          # 16 个 case
└── test_email_repository.py          # 27 个 case

docs/
├── architecture_v4_sqlite_ssot.md    # 完整架构文档
└── phase1-handoff-to-phase2.md       # 本文档
```

### 2.2 修改文件
| 文件 | 位置 | 改动 |
|---|---|---|
| `src/mail/sync_store.py` | line 95-97, 113-118, 269-329 | DB_VERSION=4，新建 `email_body` + `email_attachment` 两表 + 索引，`PRAGMA foreign_keys=ON` |
| `src/mail/new_watcher.py` | line 38-44, 114-130, 380-393, 450-490, 733-740 | imports + `self.email_repo` 初始化 + 双写入口（正向+重试） |
| `src/models.py` | line 14-15 | `Attachment` 加 `derived_from_filename` / `derived_format` |
| `src/notion/sync.py` | line 114-126 | `_convert_office_attachments` 填 derived 字段 |
| `src/config.py` | line 32-39 | `body_dual_write_enabled` / `attachment_storage_dir` |
| `.env.example` | 文件末尾 | 新配置示例 |
| `requirements.txt` | 文件末尾 | `markdownify>=0.13.1` |
| `CLAUDE.md` | "迁移与运维" 章节前 | v4 章节（schema 速查 / Repository 用法 / Phase 推进） |
| `README.md` | "邮件同步特性" + "架构说明" | v4 简介与链接 |

---

## 3. 当前生产服务状态

```
pm2 mail-sync   online   v4 dual-write + Office 预转换 已激活
db_version=4    email_metadata=8492 rows
email_body=1 row（首封测试邮件 internal_id=53677，HTML+Markdown 双存正确）
email_attachment=2 rows（内联 PNG + 原始 xlsx；derived CSV 待新邮件验证）
data/attachments/53677/   两个附件已落盘 324K，含中文文件名
```

### Phase 1 末段补丁（2026-05-15 21:56）

发现首封测试邮件触发后，xlsx → CSV 的 Office 转换跑了但 CSV 没进 SQLite 的 `email_attachment` 表。

**根因**：dual-write 在 `create_email_page_v2` 之前调用，而 Office 转换在 `create_email_page_v2` 内部跑，所以 dual-write 看不到 derived 产物。

**修复**：
- `src/notion/sync.py:_convert_office_attachments` 加 idempotency skip（已转过的原始附件不重复转）
- `src/mail/new_watcher.py:_maybe_dual_write_body` 在 commit 前先调一次 `_convert_office_attachments`，把 derived 追加到 `email_obj.attachments`

修补后流程：
1. AppleScript 抽 → Email 对象
2. **Office 预转换**（dual-write 步骤 1）→ derived CSV/PDF 加入 email_obj.attachments
3. dual-write commit → 全部附件（含 derived）写 SQLite
4. Notion sync 调 `_convert_office_attachments` → 检测已转过、跳过，直接上传 derived 到 Notion

**已 ship 的 53677 邮件影响**：缺 derived CSV 行（4 行不是 5 行）。Phase 2 实施 backfill 工具时可顺带补这一封；不阻塞 Phase 2。

### 验证命令

新 session 启动时跑这几条快速确认 Phase 1 仍健康：

```bash
# 1. v4 schema 在位
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"
# 期望: 4

# 2. 单测仍全绿
source venv/bin/activate
pytest tests/repository/ -v
# 期望: 43 passed

# 3. 生产服务在线 + v4 已加载
pm2 status mail-sync
pm2 logs mail-sync --lines 200 --nostream | grep "v4\] email body dual-write"
# 期望: online + 找到 "[v4] email body dual-write enabled (SQLite SSoT)"

# 4. 新邮件双写已发生（如果服务跑过 10 min+）
sqlite3 data/sync_store.db "
  SELECT 'body_rows=' || (SELECT COUNT(*) FROM email_body)
  UNION ALL
  SELECT 'attachment_rows=' || (SELECT COUNT(*) FROM email_attachment)
  UNION ALL
  SELECT 'recent_synced_metadata=' || (SELECT COUNT(*) FROM email_metadata
    WHERE sync_status='synced' AND updated_at > strftime('%s','now','-1 day'))
"

# 5. 附件目录有内容（首封 v4 双写邮件触发后）
ls -la data/attachments/ 2>&1 | head
```

### 异常时回滚

```bash
# 立刻关 v4 双写，退回 v3 行为
echo "BODY_DUAL_WRITE_ENABLED=false" >> .env  # 或编辑现有
pm2 restart mail-sync
pm2 logs mail-sync --lines 20 --nostream | grep -E "v4|error"
```

回滚不影响数据：`email_body` / `email_attachment` 表保留，关开关只是不再写。

---

## 4. Phase 2 工作清单

### 目标
下游消费者从"绕道"改为"直读 SQLite SSoT"。

### 4.1 P2-01 — LLM processor 改读 markdown

**入口**: `src/llm_agent/processor.py` 的 `LLMProcessor._plaintext_body`（约 line 243）

**当前实现**: 用正则 `_HTML_TAG_RE.sub(" ", html)` 硬剥 HTML（粗暴但快）

**目标实现**:
```python
def _plaintext_body(self, email: Email, internal_id: Optional[int] = None) -> str:
    """先尝试从 SQLite 读 markdown，miss 时回退正则路径。"""
    if internal_id is not None and self._repo is not None:
        md = self._repo.get_body_markdown(internal_id, max_chars=settings.llm_body_max_chars)
        if md:
            return md
    # ... fallback 现有正则逻辑
```

**关键点**:
- 需要 `LLMProcessor.__init__` 注入 `EmailRepository`（让 `runner.py` 那边传）
- LLM 拿到的 input 从"硬剥 plaintext"变成"markdownify 产物"
- **风险**：分类结果可能漂移（虽然两者语义接近）—— 见 P2-03 对比

**注意**：`llm_agent/runner.py` 的 `run_for_internal_id` 已经有 `internal_id` 参数，传给 processor 即可。

### 4.2 P2-02 — `handle_fetch_mail_content` 优先读 SQLite

**入口**: `src/events/handlers.py` 的 `EventHandlers.handle_fetch_mail_content`（约 line 507-586）

**当前实现**: 直接 `arm.fetch_email_content_by_id(internal_id, mailbox)` 重抽 AppleScript（1-3s）

**目标实现**:
```python
async def handle_fetch_mail_content(self, payload):
    internal_id = payload['internal_id']
    # 1. 优先读 SQLite（5ms）
    if self._repo is not None:
        body = self._repo.get_body(internal_id)
        if body:
            return {
                'html': body.html,
                'markdown': body.markdown,
                'source': 'sqlite-cache',
            }
    # 2. fallback AppleScript（保持现有逻辑）
    full_email = self.arm.fetch_email_content_by_id(...)
    ...
```

**关键点**:
- `EventHandlers.__init__` 注入 `EmailRepository`
- 响应载荷加 `source` 字段（'sqlite-cache' vs 'applescript-fresh'），便于排查
- **P99 期望**: 当前 1-3s → SQLite hit 后 < 100ms

### 4.3 P2-03 — 跑 1000 封对比 LLM 输出

切换前后跑 1000 封旧邮件，对比 LLM 分类结果：

```bash
# 选 1000 封最近 synced 邮件
sqlite3 data/sync_store.db "
  SELECT internal_id FROM email_metadata
  WHERE sync_status='synced' AND notion_page_id IS NOT NULL
  ORDER BY updated_at DESC LIMIT 1000
" > /tmp/ids.txt

# 跑两批：一批用旧 plaintext，一批用 markdown，对比 AILabels 结果
# （这块需要 scripts/compare_llm_path.py 之类的工具，Phase 2 实现时一并写）
```

**门槛**: 80%+ 标签一致 = 通过；< 80% 需要分析差异。

### 4.4 P2-04 — 监控 latency 指标

`handle_fetch_mail_content` 加 P99 latency 上报（Prometheus / 自建 metrics）。

### 4.5 P2-05 — Web 端切 SQLite

**单独 PR**（KevinWangQQ/MailAgent-Web）—— 不在本仓库 scope。

参考 web-handoff §7 的契约预期。

### 4.6 工时估计

Phase 2 整体 1-2 天（plan §6 Phase 2）。

---

## 5. Phase 2 关键接口（已就位）

新 session 直接用以下 API：

```python
from src.repository import EmailRepository, AttachmentStore

# 单例（注入到 LLMProcessor / EventHandlers / NotionSync 等）
repo = EmailRepository(
    db_path="data/sync_store.db",
    attachment_store=AttachmentStore("data/attachments"),
)

# 读
md = repo.get_body_markdown(internal_id, max_chars=12000)   # str | None
html = repo.get_body_html(internal_id)                       # str | None
body_full = repo.get_body(internal_id)                       # EmailBodyRecord | None
atts = repo.get_attachments(internal_id)                     # list[AttachmentRecord]
content = repo.get_attachment_bytes(attachment_id)           # bytes | None
```

`EmailBodyRecord` 字段：`internal_id, message_id, html, markdown, body_format, body_size_bytes, has_inline_images, raw_mime_sha256, fetched_at, fetched_source`

`AttachmentRecord` 字段：`id, internal_id, filename, content_type, size_bytes, is_inline, content_id, local_path, sha256, derived_from, derived_format, notion_file_id, notion_block_id, created_at`

---

## 6. Phase 2 实施注意事项

### 6.1 SQLite hit 判定要严谨

不只是 "SELECT 拿到行" → 还要检查 `body_format != 'empty'`：

```python
body = repo.get_body(internal_id)
if body and body.body_format != 'empty':
    # SQLite hit，用 markdown
else:
    # fallback AppleScript
```

### 6.2 Phase 1 双写邮件 vs 历史邮件

- **新邮件**（Phase 1 上线后）：有 SQLite body 行 → 直读
- **历史邮件**（Phase 1 上线前的 8492 封）：无 body 行 → 走 fallback

Phase 2 完成后跑历史邮件 backfill（plan T-02）才能让所有邮件都 SQLite hit。

### 6.3 LLM cache hit 率

切到 markdown 后第一次 LLM 调用会 miss cache（prefix 变了）。这是一次性的，监控时不要误判。

### 6.4 测试新模式时注意

- 不要在生产环境直接灰度（影响 LLM 分类 / 用户体验）
- 用 `scripts/run_llm_on_email.py --internal-id X --dry-run` 先单封验证

---

## 7. 关键文件索引（速查）

### 接口 / Repository
- `src/repository/email_repository.py` — `EmailRepository` 类，Phase 2 主要依赖
- `src/repository/attachment_store.py` — 附件本地 IO
- `src/repository/storage_payload_builder.py` — Email → payload（Phase 2 不动）

### v4 双写入口
- `src/mail/new_watcher.py:_maybe_dual_write_body`（line 450-484）— 双写实现
- `src/mail/new_watcher.py:_sync_single_email_v3`（line 380-393）— 正向调用点
- `src/mail/new_watcher.py:_process_retry_queue`（line 733-740）— 重试调用点

### Phase 2 要改的文件
- `src/llm_agent/processor.py` — `_plaintext_body`（P2-01）
- `src/events/handlers.py` — `handle_fetch_mail_content`（P2-02）

### 配置
- `src/config.py` — `body_dual_write_enabled` / `attachment_storage_dir`（Phase 2 不需要再加）
- `.env.example` — 已有 v4 示例

### 测试
- `tests/repository/` — Phase 1 单测（43 case）
- `tests/llm_agent/` — Phase 2 加 P2-01 单测
- `tests/events/` — Phase 2 加 P2-02 单测（不存在则建）

---

## 8. 风险与已知约束

- **`body_html` 体积**：单封邮件 HTML 可能很大（newsletter 上 MB），DB 增长需观察。Phase 1 完成后等几天看实际增速决定是否需要 `auto_vacuum=INCREMENTAL`（T-05）
- **markdownify 边界 case**：某些复杂 HTML（嵌套表格、Outlook MSO 条件注释）转 Markdown 可能丢格式；这是 LLM 输入端可接受的退化，Web 端仍用 `body_html` 渲染
- **CASCADE 死循环风险**：`PRAGMA foreign_keys=ON` 在 `_get_connection` 强制启用，旧代码若假设 FK 不生效会受影响 —— 至今未发现，但 Phase 2 改 handlers / processor 时留意
- **附件目录 orphan**：用户手动 DELETE FROM email_metadata 会触发 CASCADE 删 body/attachment 行，但本地文件不动 —— 走 `repo.delete_email_full(internal_id)` 才是完整路径。T-06 单独 CLI 处理积累

---

## 9. Phase 2 完成后的下一步

Phase 2 ship 后：
1. 监控 1 周看消费者切换稳定 → 进 Phase 3
2. Phase 3 启用 FTS5 + agent 工具 `search_email_bodies`
3. 同步推进 T-02 backfill 历史邮件（让 SQLite hit 率 100%）
4. Phase 4 改 Notion uploader 为下游消费者，架构归一
5. Phase 5 / T-01 / 其他 TODO 按优先级推进

---

> **新 session 启动建议**：先跑 §3 验证命令确认 Phase 1 仍健康，再从 §4 选一项开始实施。Phase 2 工作量 1-2 天，可一气呵成。
