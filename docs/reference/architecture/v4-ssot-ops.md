# v4 架构 SQLite-SSoT 运维速查（从 CLAUDE.md 下沉）

> 2026-05 立项，**Phase 1 + 2 + 3 已上线 2026-05-15；Phase 4 ship 2026-05-16 灰度期**。
> 把 SQLite 升级为邮件正文 + 附件的 Single Source of Truth，Notion 退化为镜像。新邮件 sync 时把 body + 附件元数据双写到 SQLite，附件二进制落 `data/attachments/{internal_id}/`。
> 设计文档：[`docs/architecture_v4_sqlite_ssot.md`](architecture_v4_sqlite_ssot.md)，Phase 间交接：[`docs/phase1-handoff-to-phase2.md`](../../archive/2026-05/phase1-handoff-to-phase2.md)。

## 关键 schema 速查

| 表 | 主键 | 用途 |
|---|---|---|
| `email_body` | internal_id (FK metadata, CASCADE) | 邮件正文：`body_html`（原始）+ `body_markdown`（markdownify 产物，LLM/RAG/FTS5 通用）+ `raw_mime_sha256` |
| `email_attachment` | id (AUTOINCREMENT) | 附件元数据：`local_path` 指向 `data/attachments/{int_id}/`；`derived_from` 自指 FK 关联 Office 转换产物（docx→pdf） |
| `email_body_fts` | virtual (rowid=internal_id) | FTS5 全文索引（Phase 3 已上线，contentful 模式，3 个 trigger 自动维护） |

## 接口层：`EmailRepository`

```python
from src.repository import EmailRepository, AttachmentStore

repo = EmailRepository(
    db_path="data/sync_store.db",
    attachment_store=AttachmentStore("data/attachments"),
)

# 读
html = repo.get_body_html(internal_id)
md = repo.get_body_markdown(internal_id, max_chars=12000)
atts = repo.get_attachments(internal_id)
content_bytes = repo.get_attachment_bytes(att.id)

# 写（事务：body + attachments 原子提交，附件落盘失败回滚）
id_map = repo.commit_email_with_body(internal_id, body, attachments, message_id=...)

# Notion sync 完成后回写
repo.update_notion_links(internal_id, file_id_map={att_id: notion_file_id})

# CASCADE 删除（含本地文件清理）
repo.delete_email_full(internal_id)

# Phase 3：全文搜索（bm25 排序 + snippet 高亮）
hits = repo.search_email_bodies("redis AND timeout", limit=20, mailbox="收件箱")
for h in hits:
    print(h.internal_id, h.rank, h.subject, h.snippet)
```

## Phase 3 FTS5 全文搜索

两个入口（PR-2a 起 Sprint 19 M2）：

- `search_email_bodies(query, ...)` — **raw FTS5**，query 原样下放给 SQLite (`MATCH`)。
- `search_email_bodies_smart(query, ...)` — **CJK-aware smart wrapper**（PR-2a, 推荐给自然语言 / LLM tool 用）。

两者都支持 FTS5 完整语法：短语 `"team meeting"`、布尔 `redis AND timeout` / `meeting NOT canceled` / `team OR group`、前缀通配 `meet*` / `产品*`、邻近 `redis NEAR(timeout, 5)`。

**Smart wrapper 算法**（`src.repository.email_repository.smart_query_transform`，跟前端 `frontend/src/electron/main/handlers/email.ts:smartQueryTransform` 1:1 对齐）：

- 单字 CJK → `X*`（prefix 通配）
- 多字 CJK token (≥2) → `(token* OR (c1* AND c2* AND ...))`：整 token prefix 优先，字符级 AND 兜底。例：`产品` → `(产品* OR (产* AND 品*))`，`本周产品评审` → `(本周产品评审* OR (本* AND 周* AND 产* AND 品* AND 评* AND 审*))`
- 多 token 间 → AND 连接：`redis 超时` → `redis AND (超时* OR (超* AND 时*))`
- 单 token 含 CJK + 拉丁混合（如 `Redis超时`）→ 按字符类切 segment，segment 间 AND
- 含 punctuation / 通配 / quote / FTS5 operator（AND/OR/NOT）→ 视为用户 explicit FTS5 syntax，**原样下放不动**

**中文搜索注意**：SQLite 自带的 `unicode61` tokenizer 把**连续 CJK 字符当一个 token**（不分词），精确搜 `产品` 命不中 token `本周产品评审`。Smart wrapper 自动处理这个洞 —— 自然语言 query `产品` 自动改写成 `(产品* OR (产* AND 品*))`，实测召回 4 倍提升。CLI 默认走 smart（`mailagent email search "产品"`），传 `--raw` 关掉 wrapper 走原 FTS5。Webhook payload 加 `mode='raw'` 同理。未来可接 jieba 或 signal-fts5-tokenizer 进一步提升质量。

**Webhook 端**: `search_email_bodies` event（自动从 Redis 消费），响应：
```jsonc
{"status": "success", "query": "产品", "mode": "smart",
 "transformed_query": "(产品* OR (产* AND 品*))",  // 仅 smart + 真改写时有
 "total_hits": 4, "latency_ms": 7,
 "hits": [{"internal_id": ..., "subject": ..., "sender": ..., "snippet": "...<mark>...</mark>...",
           "rank": -1.76, "notion_url": "..."}]}
```

**前端 chat agent tool**（`email_search_fulltext`）也默认 smart — LLM 可以直接传 `"产品评审"`、`"redis 超时"` 这种自然语言关键词，wrapper 自动 CJK-aware 改写。

## 附件 FTS5 全文搜索（PR-2b, Sprint 19 M2）

平行于 `email_body_fts` 的 attachment 文本索引。`email_attachment_text` (DB v16) 跟 `email_attachment_fts` 配套 — PDF / docx / pptx / xlsx 抽出的文本进 FTS5。索引内容 = `text_content`（一列）。

两个入口（跟 email body search 一致）：
- `EmailRepository.search_attachment_texts(query, ...)` — raw FTS5
- `EmailRepository.search_attachment_texts_smart(query, ...)` — CJK-aware smart wrapper（复用 PR-2a `smart_query_transform`）

**前端入口**：
- CLI `mailagent attachment search '<query>' [--mailbox X --since Y --until Z --limit N] [--raw]` （默认 smart）
- CLI `mailagent attachment extract --pending --include-missing [--requeue-unsupported] [--limit N --dry-run]` —— 触发抽取 pending 附件 + 一次性补 enqueue 历史 + 存量回填（见下）
- Webhook event `search_email_attachments`（自动从 Redis 消费）
- Chat agent tool `email_search_attachments`（silent tier, category=read）

**抽取流程**：
1. 邮件 sync 写 `email_attachment` 时，`commit_email_with_body` 自动 enqueue 非 inline 附件成 `email_attachment_text(status='pending')`
2. 长驻服务里的 **attachment_text worker**（`src/mail/attachment_text_worker.py` `tick_loop`，`src/service.py` 按 supervised 模式注册）每 `MAILAGENT_ATTACHMENT_TEXT_WORKER_POLL_INTERVAL_SEC`（默认 60s）跑一轮，每轮消费最多 `MAILAGENT_ATTACHMENT_TEXT_WORKER_LIMIT_PER_CYCLE`（默认 25）个 pending / retry-ready 行，自动吸收队列。总开关 `MAILAGENT_ATTACHMENT_TEXT_WORKER_ENABLED`（默认 true）；显式 false → 不 spawn worker，回纯手动现状。手动补量 / dry-run / `--include-missing` 仍用 CLI `mailagent attachment extract --pending --limit 50`（与 worker 共享单一消费逻辑 `process_pending_extractions()`，行为逐字节一致）。
3. extractor 派发：`.pdf` → pypdf（无文本层扫描件级联 Vision OCR，extractor `pdf_ocr`）/ `.docx` → python-docx / `.pptx` → python-pptx / `.xlsx` → python-calamine / `.txt/.md/.csv` → 直接 read_text / 图片（png/jpg/jpeg/gif/heic/webp/tiff/bmp）→ macOS Vision OCR（extractor `vision_ocr`，批次4 PR-G，flag `MAILAGENT_ATTACHMENT_OCR_ENABLED` 默认开；懒 import 缺 pyobjc 软着陆维持 unsupported；护栏 PDF 20 页 / 单图 15MB / 渲染长边 4096px）/ 老 Office `.doc/.ppt/.xls` → soffice 桥（`office_converter._run_soffice_convert(format=docx/pptx/xlsx)` tempdir 转出 → 复用 python-docx/pptx/calamine 抽取，extractor `soffice_bridge`，批次4 PR-H，无独立 flag；soffice 缺失 graceful 落 unsupported）
   - **anydoc lane**（task 08-10 WP2，flag `MAILAGENT_ANYDOC_ENABLED` 默认**关**）：开启后在上述派发**之前**先试 `anydoc`（`firecrawl-anydoc`，🔴 import 名 `anydoc`；纯本地 Rust、零网络零 key、零传递依赖），产出带结构的 GFM（真 `#` 标题层级 + 合法 `|---|` 表格 + 保留超链接），extractor 标 `anydoc`。生效范围由 `MAILAGENT_ANYDOC_LANES`（默认 `office,legacy`）控制：`office` = docx/pptx/xlsx/odt/odp/ods/rtf/epub + **xlsm/docm 等宏格式（原为 unsupported，属净新增）**；`legacy` = 老 OLE `.doc/.ppt/.xls`（走通即**不再需要 LibreOffice**）。🔴 **`.csv` 有意不入任何 lane**（现状直读已是最忠实产出）。
   - 🔴 **`pdf` 有意不在默认 lane 里**：25 份真实 PDF 实测 20 份与 pypdf 持平、2 份略丰富、**3 份回归** —— 其中一份把 PDF 靠重复绘制实现的伪粗体整个抽出（`TThheerreeiissnnoo…`，连续重复字符占比 0.426 vs pypdf 0.026），**它既不抛异常也不返回空 ⇒ 无判据可拦**，会静默把垃圾写进 FTS 与 AI context；另一份把 pypdf 能正常抽出 44K 字符的合同误判成 `ImageBased` 拒绝。要启用写 `MAILAGENT_ANYDOC_LANES=office,legacy,pdf`。
   - **回落纪律**：flag off / lane 未启用 / 缺包 / 转换异常 / 产出为空 —— 一律**静默完整落回**上面的原生分派（每条原生分支一字未动，off 时逐字节等价，有测试断言）。判据只认**异常类型**（`anydoc.ConvertError` 全家）与**空产出**，**不解析错误字符串**。🔴 pdf lane 真开启后 anydoc 失败的回落目标是 `_extract_pdf`（内含 pypdf → 无文本层才 OCR）而**非**直接跳 OCR —— 否则会把一份 pypdf 本可正确抽取的合同换成 OCR 猜测。
4. 成功 → `status='extracted'` + text 入 FTS5（trigger 自动同步）
5. 失败 → `status='failed'` + 指数退避（1m / 5m / 15m / 1h / 2h）；超 5 次 → `next_retry_at=NULL` dead
6. unsupported (zip / 无 soffice 时的 .doc/.ppt/.xls / 未知二进制) → `status='unsupported'` 不索引也不重试
7. **存量回填**（extractor 覆盖面扩展后把历史终态行拨回重跑）：`mailagent attachment extract --requeue-unsupported [--dry-run]` —— 圈选 `status='unsupported' AND 扩展名 ∈ (OCR 图片集 ∪ 老格式集)` + `status='failed' AND 扩展名 = .pdf` → `UPDATE ... SET status='pending'`（清 retry/error），worker 用新 extractor 重跑。扩展名集单源 `attachment_text.py` 的 `OCR_IMAGE_EXTENSIONS`/`LEGACY_OFFICE_EXTENSIONS`；`enqueue_attachment_text_extraction` 的 `INSERT OR IGNORE` 幂等语义不动（已存在的 `unsupported` 行不会被 `--include-missing` 捕获，`--requeue-unsupported` 是唯一显式重置路径）

**Cap**: 单 attachment 文本 ≤ 256 KB（utf-8 字节）。超出 `truncated=True` 标记，FTS5 索引大小可控。

**响应示例**（webhook `search_email_attachments`）：
```jsonc
{"status": "success", "query": "合同条款", "mode": "smart",
 "transformed_query": "(合同条款* OR (合* AND 同* AND 条* AND 款*))",
 "total_hits": 3, "latency_ms": 12,
 "hits": [{"attachment_id": 7821, "internal_id": 53675,
           "filename": "supplier_contract.pdf",
           "email_subject": "供应商合同 v3", "email_sender": "alice@acme.com",
           "snippet": "...条款 6.2 <mark>付款</mark>方式...", "rank": -2.34,
           "notion_url": "..."}]}
```

详见 [`docs/phase3-complete.md`](../../archive/2026-05/phase3-complete.md)。

## Phase 4 重传 CLI

```bash
# Notion 重传（基于 SQLite，不调 AppleScript）
mailagent email resync 53675 --dry-run                                    # 看 plan
mailagent email resync 53675 --replace-existing                           # archive 老页 → 建新
mailagent email resync --range 53000-53100 --replace-existing
mailagent email resync --ids 53674,53675,53677

# Office 衍生附件补救（追加 derived row，不动现有 row；适合 backfill silent fail）
mailagent backfill derivatives --dry-run                                  # 看候选数
mailagent backfill derivatives --internal-id 53677                        # 单封
mailagent backfill derivatives                                            # 全量补
```

**注意**:
- `mailagent email resync` 默认 `skip_parent_lookup=True`（diff 验证用），新页不会重建线程关系
- `mailagent backfill derivatives` 补完后，Notion 老页**不会**自动出现 derived 附件；要更新需要 `mailagent email resync --replace-existing`
- 灰度切 `NOTION_READ_FROM_SQLITE=true` 操作步骤见 [`docs/phase4-complete.md`](../../archive/2026-05/phase4-complete.md) §6

## 关键开关

| 配置 | 默认 | 说明 |
|---|---|---|
| `BODY_DUAL_WRITE_ENABLED` | `true` | v4 双写总开关；失败仅 warning 不阻断 Notion sync |
| `ATTACHMENT_STORAGE_DIR` | `data/attachments` | 附件本地落盘根目录 |
| `NOTION_READ_FROM_SQLITE` | `false` | v4 Phase 4：`create_email_page_v2` 是否优先走 SQLite SSoT 路径。默认灰度期 false；切 true 后正常 sync + resync 都走 `create_email_page_from_sqlite`，miss 时自动 fallback 老路径 |

## 双写流程（v4 vs v3）

v3 sync 路径：AppleScript → in-memory Email → Notion blocks。

v4 sync 路径：AppleScript → in-memory Email → **build_storage_payloads + repo.commit** → Notion blocks（不变）。

双写点位：`src/mail/new_watcher.py` 的 `_sync_single_email_v3` 与 `_process_retry_queue` 都在 Notion sync 之前调 `_maybe_dual_write_body`。

## Phase 推进

| Phase | 状态 | 内容 |
|---|---|---|
| Phase 1 | ✅ **已上线 2026-05-15** | 双写 MVP；新邮件 sync 时落 SQLite，Web 端可立即切表。43/43 单测通过、生产服务已加载 v4 |
| Phase 2 | ✅ **已上线 2026-05-15** | LLM processor / handle_fetch_mail_content 直读 SQLite（命中 ~4ms vs AppleScript 1-3s）；P99 latency tracker；回归对比工具就位。详见 [`docs/phase2-complete.md`](../../archive/2026-05/phase2-complete.md)。回退开关 `LLM_PREFER_SQLITE_BODY=false` |
| Phase 3 | ✅ **已上线 2026-05-15** | FTS5 全文索引 + `search_email_bodies` agent 工具；webhook bm25 排序 + snippet 高亮 + mailbox/date 过滤。274/274 单测通过。详见 [`docs/phase3-complete.md`](../../archive/2026-05/phase3-complete.md) |
| Phase 4 | ✅ **已 ship 2026-05-16（灰度期）** | `create_email_page_from_sqlite` 主入口 + v2 wrapper 路由 (`NOTION_READ_FROM_SQLITE`) + `mailagent email resync` + `mailagent backfill derivatives` CLI（PR-6 起取代旧 `scripts/resync_notion.py` / `scripts/backfill_derivatives.py`）。上传后 `notion_file_id` 回写 SQLite。295/295 单测、3 封灰度切换实测 OK。详见 [`docs/phase4-complete.md`](../../archive/2026-05/phase4-complete.md) |
| Phase 5 | 未来 | Electron / Web 前端（接口已就位） |
| **T-01** | ⛔ 决定不迁 | Notion sync 迁 Markdown API — 评估后 Notion Markdown API 仅支持 page 正文 markdown，不支持 inline image / file_upload block / 复杂 properties，对邮件复杂渲染（cid 内联图、附件 block、AI 字段写入）**不可替代**当前 blocks API 路径。保留现状 |

## 关键文件

- `src/repository/` 整个目录（EmailRepository / AttachmentStore / build_storage_payloads / search_email_bodies）
- `src/converter/html_to_markdown.py`（markdownify 主路径）
- `src/mail/sync_store.py:95-410`（DB_VERSION=5，含 email_body / email_attachment / email_body_fts + trigger）
- `src/mail/new_watcher.py:114-130, 380-393, 450-490, 733-740`（双写入口）
- `src/events/handlers.py:745-855`（`handle_search_email_bodies` webhook）
- `tests/repository/`（单测，含 `TestSearchEmailBodies`）+ `tests/events/test_search_email_bodies.py`

## 运维

```bash
# 看新邮件双写是否正常（pm2 重启后等 5-10 min）
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body WHERE fetched_at > strftime('%s','now','-10 min')"

# 看 body / attachment 存量
sqlite3 data/sync_store.db "
  SELECT
    (SELECT COUNT(*) FROM email_body) AS bodies,
    (SELECT COUNT(*) FROM email_attachment) AS attachments,
    (SELECT COUNT(*) FROM email_attachment WHERE derived_from IS NOT NULL) AS office_converted
"

# 看附件目录大小
du -sh data/attachments/

# Phase 3：FTS5 索引健康度（body ↔ fts 行数应该一致）
sqlite3 data/sync_store.db "
  SELECT
    (SELECT COUNT(*) FROM email_body) AS bodies,
    (SELECT COUNT(*) FROM email_body_fts) AS fts_rows,
    (SELECT COUNT(*) FROM email_body) - (SELECT COUNT(*) FROM email_body_fts) AS gap"

# 手测一次 search（不走 webhook）
python -c "
from src.repository import EmailRepository
for h in EmailRepository('data/sync_store.db').search_email_bodies('meeting', limit=3):
    print(f'{h.internal_id} bm25={h.rank:.2f} | {h.subject[:50]}')"

# 单测
pytest tests/repository/ tests/events/ -v

# 紧急回滚：关 v4 双写 —— 在 .env 加 BODY_DUAL_WRITE_ENABLED=false 然后 pm2 restart mail-sync
```

## T-02 历史邮件 backfill ✅ 已完成（2026-05-15 跑完，PR-6 起 CLI 改走 `mailagent backfill body`）

Phase 1 之前已 sync 到 Notion 的历史邮件正文已回填到 SQLite，让 LLM 路径口径统一。
当前覆盖率：**6031 / 6134 = 98.3%**（差额 103 封是 `fetch_failed` / `dead_letter`，不是 backfill 漏跑）。
FTS5 索引同步（6031 rows）。详见 [`docs/phase2-complete.md`](../../archive/2026-05/phase2-complete.md) §7。

剩余 103 封死信邮件可走 `mailagent admin dead-letter retry <internal_id>` 单封触发重试，backfill 工具本身无需再跑。下方命令保留作回放 / 应急参考：

```bash
# 单封验证（dry-run）
mailagent backfill body --internal-ids 53675 --dry-run

# 全量后台跑（必须先 stop pm2 mail-sync 避免 AppleScript 拥塞）
pm2 stop mail-sync
nohup mailagent backfill body --all > logs/backfill.log 2>&1 &
# 进度：tail -f logs/backfill.log 或 sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body"
# 跑完：pm2 start mail-sync
```
