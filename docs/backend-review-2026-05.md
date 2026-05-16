# MailAgent 后端架构 Review（v4 Phase 4 灰度期）

> **Review 阶段**: 阶段 B（架构层 review），不写代码、不动逻辑、纯产出报告。
> **前置阅读**: [`phase4-handoff-backend-review-and-agent-cli.md`](./phase4-handoff-backend-review-and-agent-cli.md), [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md), [`phase4-complete.md`](./phase4-complete.md), `CLAUDE.md`
> **Review 时点**: 2026-05-16 灰度切 `NOTION_READ_FROM_SQLITE=true` 之后、生产 mail-sync 重启前；backfill 仍在 `--since-date 2026-03-01` 进度（pid 29361）。
> **覆盖范围**: 后端模块（`src/` + 入口 `main.py` + 主要 `scripts/*.py`），不含 `webhook-server/`（远程 VPS 部署，与 CLI 设计无直接耦合）。
> **本次产出**: 仅 markdown 报告 + 少量 handoff 文档修正。不修代码。

---

## 0. Executive Summary

后端架构总体扎实：v3 internal_id 主键 + v4 SQLite SSoT + 5 个 Phase 渐进切换，每一步都留了灰度开关与回滚路径。本轮 Review 没有发现 P0 级的"架构上必须立刻修"的问题。但有若干 **P1 / P2 级事实问题**值得在进入 Agent CLI 设计前先达成共识：

- **P1**：测试 `test_disabled_by_default` 与 `.env` 真实值耦合（灰度切 true 后必然失败）—— 阻塞 CI 信号 _(待 PR-1 Commit 8 修)_
- **P1**：`fetched` sync_status 是死代码（schema/类型注释里有，但无 `mark_fetched` 路径写入）—— 状态机文档与实现不一致 ✅ **Fixed in PR-1**
- **P1**：`NotionSync` lazy-init `_repo / _sync_store / AttachmentStore`，与 `NewWatcher` 已持有的实例**不共享** —— 生产单进程内有 2 套 EmailRepository + 2 套 SyncStore + 2 套 AttachmentStore ✅ **Fixed in PR-1** (strict DI)
- **P2**：`_handle_thread_relations` 仍走 Notion API 查兄弟邮件，**未利用 SQLite SSoT 已有的 thread_id 索引** —— Phase 4 灰度后这一路径仍是 Notion 出/入双向 ✅ **Fixed in PR-1** (SQLite SSoT 优先 + Notion fallback)
- **P2**：`EmailRepository.commit_email_with_body` 返回 dict 的 key 用**原始 filename**，但 SQLite 内部用 **sanitize 后的 filename**；调用方未踩坑只是因为暂时没人立即消费返回值
- **P2**：`AttachmentStore.read` 用 `Path.cwd()` 解析相对路径，CLI 在非项目根目录执行会失败 ✅ **Fixed in PR-1**
- **P2**：`scripts/*` 有 47 个文件，混杂 5 类（核心 CLI / 检查调试 / 旧测试 / 一次性迁移 / shell helper），无统一规范 —— 影响阶段 D CLI 设计的边界

**重构建议**（用户拍板）：见 §6。其中"NotionSync 改 strict DI"和"thread relations 切 SQLite"是阶段 D CLI 设计前最值得拍板的两条。

---

## 1. 摸底确认 / handoff §5 偏差

| 项目 | handoff §5 期望 | 实际 | 备注 |
|---|---|---|---|
| 最近 5 commit | `dac9888 8e0c64e c261242 c175ac8 298a6dc` | `5d6cf7e dac9888 8e0c64e c261242 c175ac8` | handoff 文档自我引用偏差，已修 |
| `db_version` | 5 | 5 | ✓ |
| pytest | 295 passed | 294 passed + 1 failed | `.env` 切换副作用，已注 |
| `NOTION_READ_FROM_SQLITE` | true | true | ✓ |
| backfill 进程 | 在跑 | pid 29361 在跑 | `scripts/backfill_email_body.py --since-date 2026-03-01` |
| `pm2 mail-sync` | stopped | stopped | ✓（让 backfill 跑完再 start） |

**v4 数据规模（截至 review）**：

```
metadata=8493   body=2397   fts=2397   attachments=8425
derived=365     notion_file_id=7
```

观察：
- `body / metadata = 2397 / 8493 ≈ 28%` —— 双写从 Phase 1 上线（2026-05-15）开始；这 2397 = 上线后新邮件 + backfill 已处理的部分历史邮件
- `notion_file_id=7` —— 仅 Phase 4 切灰度后用 `resync_notion.py / backfill_derivatives.py` 测试过的少量附件。生产 sync 路径还没真正灰度过（mail-sync 停着）
- `derived=365` —— Office 转换产物（docx→PDF, xlsx→CSV）已落 SQLite

**handoff 其他偏差**（已识别，未修文档）：

- §2.2 模块布局漏了 `src/utils/`（含 `logger.py`，被 `main.py` 引用）—— 不影响 CLI 设计但应补
- §2.4 写"43 个脚本"，实际 `scripts/` 下 47 个（多了 `compare_llm_path.py` Phase 2 对比工具、`replay_recurring_invite.py` 会议重放、`html_clipboard.py`、`keep_alive.py`、`test_office_converter.py` 等已存在但未列入分类）
- §2.5 提到"`new_watcher.py:945` / `notion/sync.py:1400` / `events/handlers.py:855` / `reader.py:700`" —— 现状行数 889/1745/856/820，前两者偏差较大（涨/缩），后两者 OK。**不影响 review 结论**

---

## 2. 架构 Review（按 handoff §3.1 六个角度）

### 2.1 数据流端到端

#### 写路径（new email → SQLite + Notion）

```
SQLite Radar 检测 max_row_id 变化
  └─→ radar.get_new_emails(since_row_id)               # 直接从 Mail.app SQLite 取 metadata（不走 AppleScript）
      └─→ sync_store.save_email({sync_status: 'pending', message_id: None})
          └─→ sync_store.set_last_max_row_id(current_max)

_process_pending_emails (limit=10)
  └─→ _sync_single_email_v3:
       arm.fetch_email_content_by_id(internal_id, mailbox)   # AppleScript ~1s
       sync_store.update_after_fetch                          # 填 message_id / thread_id
       meeting_sync.process_email                             # iCal 检测
       _build_email_object (reader.parse_email_source)
       [date filter]
       _maybe_dual_write_body:
         notion_sync._convert_office_attachments              # 预转 docx→PDF / xlsx→CSV
         build_storage_payloads + repo.commit_email_with_body  # 事务: body + attachments + 落盘
       notion_sync.create_email_page_v2(email_obj)            # ← 灰度 wrapper
         ├─ if NOTION_READ_FROM_SQLITE and body 命中 → create_email_page_from_sqlite
         └─ else → 老路径 (从 in-memory email 直接走 v2 流程)
       sync_store.mark_synced_v3(internal_id, page_id)
       _maybe_trigger_project_progress_hook (非阻塞)
       _maybe_trigger_llm_hook (非阻塞)
```

**事实陈述**：
- **F1.1**：双写在 Notion sync **之前**（`new_watcher.py:424`）。如果 dual-write 抛异常 → `_maybe_dual_write_body` catch 住只 warning，Notion sync 仍执行。这是设计选择（不阻断主流程），但灰度切 true 后会有微妙副作用：dual-write 失败 → wrapper 检查 body miss → fallback 老路径 → 用户看不出来"灰度其实没生效"。**没有指标分离 from-sqlite hit vs miss vs dual-write-failed**。`fetch_mail_content` 上有 P99 latency 监控（handlers.py:74），但 `create_email_page_v2` 没有。
- **F1.2**：`_convert_office_attachments` 在 dual-write 和 Notion v2 路径都被调用（`new_watcher.py:474` + `notion/sync.py:1064`）。second pass 用 `already_converted_origins` 跳过（`notion/sync.py:131-138`），不会重复转。但 dual-write 失败后 second pass **还会再转一次**（因为 email_obj.attachments 没扩展过）—— 设计上无害但**事实陈述**：单封邮件转 Office 附件最多被尝试 2 次。
- **F1.3**：write path 中 retry 队列 `_process_retry_queue` (line 665) 也走 dual-write（line 754）—— 一致。

#### 读路径（消费者 → SQLite SSoT 或 fallback）

| 消费者 | 入口 | SQLite 优先 | Fallback | 备注 |
|---|---|---|---|---|
| `handle_fetch_mail_content` | webhook | ✓ (handlers.py:591) | AppleScript | latency p99 监控完备 |
| `handle_search_email_bodies` | webhook | ✓ FTS5 only | 无 | 历史邮件未 backfill 则不在结果集 |
| `LLMProcessor._plaintext_body` | new_watcher hook + CLI | ✓ (processor.py:249) | 内存正则 | `cfg.llm_prefer_sqlite_body` 控 |
| `create_email_page_from_sqlite` | resync CLI + wrapper 灰度路径 | ✓ | wrapper 检测 body miss 走老路径 | 主入口 |
| `reverse_sync.sync_single_page` | 反向同步循环 | ✗ | sync_store.get + AppleScript | **未走 SSoT**，仍用 message_id → internal_id |
| `_handle_thread_relations` | v2 / from_sqlite 共用 | ✗ | Notion API 查兄弟 | **未利用 SQLite thread_id 索引**（见 §2.2 / R-02） |

**事实陈述**：
- **F1.4**：`handle_fetch_mail_content._try_fetch_from_sqlite` 把 `body_format == 'empty' or not body.markdown` 判定为 miss，回退 AppleScript（`handlers.py:641`）。意味着"邮件正文实际就是空（纯附件邮件）"会一直走慢路径。从语义上空就是空，重抽一次 AppleScript 也会得到空内容 —— 是设计还是 bug 看视角。**可能浪费**：每个真正空内容的邮件每次查询都触发 ~1s AppleScript。
- **F1.5**：`_handle_thread_relations` 走 Notion API（`notion/sync.py:1322` → `_find_all_thread_members_with_date` 查 data_source）。SQLite 已有 `thread_id` 索引（`sync_store.py:212`）和 `get_all_emails_by_thread_id`（line 1102），但 Notion 写入路径没用上 —— 错过 SSoT 收益。

### 2.2 模块边界

| 模块 | 职责 | 与谁耦合 |
|---|---|---|
| `repository/` | v4 SSoT 读写 + FTS5 + AttachmentStore | 依赖 sqlite3，无业务上下文。**干净**。 |
| `mail/` | 摄入 + 状态机 + 反向同步 + AppleScript 抽象 | 内部耦合紧密（`new_watcher` ↔ `sync_store` ↔ `arm` ↔ `radar` ↔ `meeting_sync`）。OK。 |
| `notion/sync.py` | Notion 写入 + 线程关系 + reverse-sync 查询 + v4 桥接 | **承担过多**：v2 老路径 + from_sqlite 新路径 + thread relations + reverse_sync helpers + flag update + meeting callout build。1745 行。 |
| `events/handlers.py` | 7 个 webhook handler | 复用 `arm / sync_store / feishu / notion_sync / email_repo` 共 5 个依赖 |
| `llm_agent/` | LLM 分类填 AI 字段 | 一个 sub-package 独立得当；processor + runner + writer 分工清晰 |

**事实陈述**：
- **F2.1**：`NotionSync.__init__` 接 `repo`、`sync_store` 但默认 None；当 `NOTION_READ_FROM_SQLITE=true` 触发 wrapper 时通过 `_ensure_sqlite_resources()` lazy 创建（`notion/sync.py:45-54`）。**生产单进程内并存的实例数**：
  - `NewWatcher.email_repo`（new_watcher.py:129）
  - `NewWatcher.sync_store`（new_watcher.py:114）
  - `NotionSync._repo`（first wrapper invocation 后惰性创建）
  - `NotionSync._sync_store`（同上）
  - `AttachmentStore`：new_watcher 一个 + NotionSync.\_repo 内部一个（注意 NotionSync lazy 创建时**没传 `attachment_storage_dir`**，用 `AttachmentStore()` 默认值，恰好默认就是 `data/attachments` 与配置一致，否则会 silent 错配）
  - `LLMRunner._processor._repo`（llm_agent/runner.py:67 又起一个，理由：让 CLI 不传 repo 也能享受 SQLite 路径）

  共 **3 套 EmailRepository + 2 套 SyncStore + 3 套 AttachmentStore** 并存。SQLite WAL 下并发读取无 mutex 但 connection 不池化 → 每次方法 open/close 一个 connection。**目前可接受**（吞吐量小）但是接口层 DI 设计破碎。

- **F2.2**：`reverse_sync.py:180` 在 fallback 路径 `SQLiteRadar(account_url_prefix=...)` 又起一个 SQLiteRadar 实例（不复用 watcher 的）。SQLiteRadar 内部每次也开关 Mail.app SQLite —— 不严重，但事实上又是一个"应注入而非创建"的位置。

- **F2.3**：`notion/sync.py` 1745 行兼承 3+ 个职责：
  1. **页面 CRUD**（create_email_page_v2 / from_sqlite, _build_properties, _build_children, sanitize blocks）
  2. **Thread relations**（_handle_thread_relations, _find_all_thread_members_with_date, update_sub_items, update_parent_item）
  3. **Reverse sync 查询**（query_pages_for_reverse_sync, update_page_mail_sync_status, update_email_flags, query_by_row_id）
  4. **v4 桥接 helpers**（_restore_cid_in_body_html, _materialize_attachments, _build_email_from_sqlite, _build_file_id_map, _ensure_sqlite_resources）
  5. **批量查询**（query_all_message_ids, query_all_row_ids）

  这是 review 阶段的事实陈述；是否拆分留给阶段 C 决定。

### 2.3 状态机一致性

`email_metadata.sync_status` schema 注释里列了 7 个状态：

```
pending / fetch_failed / fetched / synced / failed / skipped / dead_letter
```

**事实陈述**：
- **F3.1**：**`fetched` 状态是死代码**。grep 全仓库：
  - 出现在 `sync_store.py:81`（TypedDict 字段注释）
  - 出现在 `sync_store.py:1302`（`get_emails_by_status` docstring）
  - 出现在 architecture_v4 / CLAUDE.md 的状态流转说明
  - **不出现在任何写入语句**

  实际流转是 `pending` → `synced`（一步）或 `pending` → `fetch_failed` → ... → `synced` / `failed` / ...。`fetched` 只是文档幻觉。**P1 事实陈述**。

- **F3.2**：状态机所有写入都经过 4 个 setter：
  - `update_after_fetch`（更 message_id + thread_id 但**不动 sync_status**）
  - `_update_for_retry`（→ fetch_failed / failed / dead_letter / skipped）
  - `mark_synced_v3` / `mark_skipped`（→ synced / skipped）
  - `mark_pending`（→ pending，用于 manual 重置）

  路径单一，便于 review。OK。

- **F3.3**：死信降级例外（发件箱 fetch_failed 用尽 → skipped 而非 dead_letter，`sync_store.py:753-771`）—— 设计正确（CLAUDE.md 已记录），避免发件箱漏一封被无意义告警。

- **F3.4**：retry 队列：
  ```sql
  WHERE sync_status IN ('fetch_failed', 'failed')
    AND next_retry_at IS NOT NULL
    AND next_retry_at <= ?
  ```
  `dead_letter / skipped` 不被选 → 单次失败的邮件**永远不会自然回到 retry 队列**（除非 human 调 `retry_dead_letter`）。OK，这是预期。

### 2.4 并发与锁

- **SQLite**：WAL 模式启用（`sync_store.py:119`），FK PRAGMA 启用（line 120 + 400 重复但无害）。`timeout=30s` busy_timeout 兜底。
- **AppleScript**：单进程串行，无显式锁。`_execute_script` 用 subprocess.run 同步调（`applescript_arm.py:536`），AppleScript bridge 本身不并发。
- **Redis consumer**：BLPOP 单线程消费，handler `await` 串行。设计上避免两个 AppleScript 并发抢锁，但**单条慢 handler 会阻塞整个队列**（如 `handle_fetch_mail_content` 走 AppleScript fallback ~1-3s 期间，其他事件等）。
- **dual-write**：连接独立于 sync_store 主连接（EmailRepository 用独立 `_connect()`）。WAL 下读不阻塞写、写也不阻塞读 —— 但写之间会串行（同一个 db file）。

**事实陈述**：
- **F4.1**：双写时 EmailRepository commit 与 sync_store 的 `save_email / mark_synced_v3` 是**两个独立事务**。如果 dual-write commit 成功但 `mark_synced_v3` 失败 → SQLite 有 body 但 sync_status 还是 pending → 下次轮询 `_process_pending_emails` 又拿到这封 → 再来一次：AppleScript fetch + dual-write commit（INSERT OR REPLACE 覆盖）+ Notion check exists 命中 → 拿到现有 page_id 走 update / 返回 → mark_synced_v3。**幂等性靠 Notion 的 `check_page_exists`**。OK 但脆弱。
- **F4.2**：retry 队列处理 limit=3 / pending 处理 limit=10，每轮 poll 5s 一次。理论吞吐 (10+3)/5s ≈ 2.6 emails/sec（不含 AppleScript 时间）。实际受 AppleScript 串行限制，每封 ~1s → 实际 ~10 emails/cycle in 13s = ~0.77/s 上限。**事实陈述**：单 watcher 单线程，受 AppleScript 串行天花板限制。

### 2.5 v4 灰度回滚路径

**回滚开关组合**：

| `BODY_DUAL_WRITE_ENABLED` | `NOTION_READ_FROM_SQLITE` | 行为 |
|---|---|---|
| true (default) | false (handoff 期望灰度起点) | 新邮件双写 SQLite + Notion 走老路径。可逐邮件人工 diff |
| true | **true (当前)** | 新邮件双写 + Notion 走 SQLite SSoT；body miss 自动 fallback 老路径 |
| false | true | 不再双写新邮件 → 后续新邮件 body miss → 全走 fallback 老路径。**不可用状态**：等于"想用 v4 但又不喂数据" |
| false | false | 完全 v3 老行为。但已落 SQLite 的历史数据保留 |

**事实陈述**：
- **F5.1**：灰度切 true **没有任何监控指标**告诉运维 "wrapper 路由发生了多少次 from-sqlite vs fallback miss"。只有 `pm2 logs` debug 输出（`notion/sync.py:1012, 1023`）。等 mail-sync 重启后这些日志默认是 DEBUG 级别，可能被过滤。
- **F5.2**：Phase 4 完整回滚（`git revert`）会丢失 `email_attachment.notion_file_id` 回写功能 —— 但 SQLite 数据不会丢，重新跑 `resync_notion.py` 还能补。回滚干净。
- **F5.3**：当前生产实际状态：mail-sync stopped，灰度切 true 但 0 封新邮件实测。`notion_file_id=7` 来自手动 resync 测试，**没有真正经过 production sync 路径验证灰度**。

### 2.6 接口契约（EmailRepository）

**事实陈述**：
- **F6.1**：`commit_email_with_body` 返回 `dict[str, int]`：key 是 `att.filename`（原始 filename，第 462 + 472 行），value 是 SQLite 主键 attachment.id。但 SQLite 内部存的是 `disk["used_filename"]`（sanitize 后）。这意味着**如果原 filename 含特殊字符**（如 `report (final).pdf`），调用方拿返回 map 用 sanitize 后的 filename 查会 KeyError。当前所有调用方都没立即用返回值（`new_watcher._maybe_dual_write_body` 直接丢弃），所以**未踩坑**但属于 API 契约不一致。
- **F6.2**：`get_attachment_bytes` 经由 `AttachmentStore.read` → `Path.cwd()` 解析相对 `local_path`（`attachment_store.py:117-123`）。CLI **从 `~/Documents/MailAgent` 之外的目录执行**会失败（`local_path` 是 `data/attachments/X/file.ext` 相对路径）。**P2 事实陈述**：CLI 设计阶段必须解决这个 cwd 依赖。
- **F6.3**：`delete_email_full` 不在事务里 wrap 文件删除（line 525-534）：先 DB 删（CASCADE 触发 body/attachment 行删除），后 `attachment_store.delete_email_dir`。如果文件删失败，DB 已 commit → 孤儿目录。T-06 cleanup 兜底，但**事实陈述**：CASCADE 删 + 文件删不是原子的。
- **F6.4**：没有 `get_metadata(internal_id)`：要拿邮件 metadata 必须直接 `sync_store.get()`。`EmailRepository` 是 "body + attachment only"，metadata 仍由 `SyncStore` 独立提供。结果：`handle_fetch_mail_content / create_email_page_from_sqlite` 等所有 SSoT 消费者都必须**同时持有 repo 和 sync_store** —— **接口 cluster split**。CLI 设计需要考虑统一封装。
- **F6.5**：没有批查询接口：`list_emails(filter, limit, offset)` 不在 EmailRepository（只在 `sync_store.search_emails` 和 `sqlite_radar.search_all_emails`，两者 schema 不同）。CLI 设计的 `mailagent email list` 命令需要协调这两个 API。

---

## 3. 测试覆盖盲区

| 模块 | 单测路径 | 状态 |
|---|---|---|
| `repository/` | `tests/repository/test_email_repository.py` + `test_attachment_store.py` | ✓ 含 FTS5 测试 |
| `notion/sync.py` from_sqlite | `tests/notion/test_create_from_sqlite.py` | ✓ 21 cases，但 1 known fail |
| `llm_agent/` | `tests/llm_agent/test_{processor,schema,digest,md_to_rich_text,writer}.py` | ✓ |
| `events/handlers.py` | `tests/events/test_{fetch_mail_content,search_email_bodies}.py` | ✓ 限 2 个 handler |
| `mail/meeting_sync.py` | `tests/mail/test_meeting_sync_recurring.py + test_expansion_loop.py` 等 | ✓ |
| `project_progress/` | `tests/project_progress/` | ✓ |
| **`mail/new_watcher.py`** | 无 | ✗ |
| **`mail/sync_store.py`** | conftest 用作 fixture，无独立单测 | ✗ |
| **`events/redis_consumer.py`** | 无 | ✗ |
| **`mail/reverse_sync.py`** | 无 | ✗ |
| **`mail/applescript_arm.py`** | 无（macOS 限定，难 mock） | ✗ |
| **`mail/sqlite_radar.py`** | 无（macOS Mail.app SQLite 限定） | ✗ |

**事实陈述（与 handoff §2.5 一致）**：`new_watcher / sync_store / redis_consumer / reverse_sync` 这四个主路径文件无独立单测，主要靠 e2e 跑通验证。这是接受的成本 —— AppleScript / Mail.app SQLite 没法 mock，但状态机 / 重试调度 / 事件路由 / 错误处理是**纯 Python 可测的**，目前未测。CLI 设计阶段若新增模块也应避免这个盲区。

---

## 4. 已识别问题清单（事实陈述，**必须**关注）

| ID | 级别 | 文件:行 | 说明 |
|---|---|---|---|
| **I-01** | P1 | `tests/notion/test_create_from_sqlite.py:574-608` | `test_disabled_by_default` 未 monkeypatch `notion_read_from_sqlite=False`，依赖 `.env` 真值。用户切 `NOTION_READ_FROM_SQLITE=true` 后该用例必失败。修法：在 setUp / fixture 显式设回 False。 ✅ **Fixed in PR-1** (Commit 8 monkeypatch) |
| **I-02** | P1 | `src/mail/sync_store.py:81,1302` + `docs/architecture_v4_sqlite_ssot.md` + `CLAUDE.md` | `fetched` 状态在 schema/类型注释/架构文档/CLAUDE 状态机图都有声明，但 codebase 无任何 `mark_fetched()` 写入路径。死代码。修法：要么实现该过渡状态（在 `update_after_fetch` 里同时设 sync_status=fetched），要么从所有文档/类型注释里删 `fetched`。 ✅ **Fixed in PR-1** (Commit 6 删 search_emails 死状态 + 状态机回归测试) |
| **I-03** | P1 | `src/notion/sync.py:42-54` + `src/mail/new_watcher.py:119` | `NotionSync()` 无参构造，wrapper 触发时 `_ensure_sqlite_resources()` lazy 创建 `EmailRepository / SyncStore / AttachmentStore` 全新实例，与 `NewWatcher` 已持有的实例不共享。单进程内 3 套 repo + 2 套 sync_store + 3 套 attachment_store 并存。 ✅ **Fixed in PR-1** (Commit 3 strict DI + 12 调用点改造) |
| **I-04** | P2 | `src/repository/email_repository.py:434, 462` | `commit_email_with_body` 返回值 dict 的 key 是 `att.filename`（原始），SQLite 内存 `used_filename`（sanitize 后），调用方拿返回值要小心；当前未踩坑只是因没人立即消费。 |
| **I-05** | P2 | `src/repository/attachment_store.py:117-123` | `AttachmentStore.read` 用 `Path.cwd()` 解析相对路径。CLI 从非项目根执行会失败。修法：让 AttachmentStore 在构造时记录 `base_dir.resolve()` 或拼绝对路径。 ✅ **Fixed in PR-1** (Commit 5 base_dir.resolve() + base_dir 反推 project_root) |
| **I-06** | P2 | `src/notion/sync.py:1305-1372` | `_handle_thread_relations` 走 Notion API 查兄弟邮件，没用 SQLite `thread_id` 索引。Phase 4 灰度后这一路径仍依赖 Notion 数据。 ✅ **Fixed in PR-1** (Commit 4 SQLite SSoT 优先 + Notion fallback) |
| **I-07** | P2 | `src/notion/sync.py:1912`（PR-4 后） | `NotionSync` 类承担 5+ 职责（页面 CRUD / thread / reverse sync 查询 / v4 桥接 / 批量查询）。1912 行单文件难导航与测试。 ✅ **Fixed in commit 76abc45**（拆 sync.py 409 facade + pages.py 1145 + threads.py 281 + queries.py 378 + _common.py 122；`RolloutMetrics` 抽到 _common；public API 11 调用点零改动；612/612 测试持平） |
| **I-08** | P2 | `src/events/handlers.py:641` | `_try_fetch_from_sqlite` 把"body markdown 是空字符串"判定为 miss → 走 AppleScript fallback。纯附件邮件每次查询都触发 ~1s AppleScript。 |
| **I-09** | P2 | `src/repository/email_repository.py:525-534` | `delete_email_full` 先 DB 删（CASCADE）再删文件，非原子。文件删失败留孤儿目录。T-06 cleanup 兜底。 |
| **I-10** | P2 | `src/llm_agent/runner.py:67` + `src/mail/new_watcher.py:172` + `src/notion/sync.py:48-50` | 3 个独立位置创建 `EmailRepository`，3 套配置（new_watcher 用 `attachment_storage_dir`，runner 用同 cfg，NotionSync 用默认 "data/attachments"）。**默认相同所以没出问题**，但配置不一致就会 silent 错配。 |
| **I-11** | P2 | `src/notion/sync.py:1004-1038` wrapper 灰度路由 | 切 true 后 fallback 老路径**没有 metric / 没有 warning**，运维不知 "灰度生效率"。建议加 stats counter（from_sqlite_hit / fallback_miss / fallback_error）+ 暴露到 dashboard。 |
| **I-12** | P3 | `src/mail/sync_store.py:892-907` `_save_email_compat` | `internal_id = -abs(hash(message_id)) % 2147483647`。Python `hash()` 在不同进程间不保证一致（PYTHONHASHSEED），同一 message_id 跨进程可能算出不同临时 internal_id。生产里只有 `save_email` 路径走 v3 真实 ID，**已被边缘化**，但**事实陈述**：兼容代码仍可能被 `initial_sync.py` 老路径触发。 |
| **I-13** | P3 | `src/llm_agent/processor.py:113` 类名 `AnthropicClient` | client.py 已支持 OpenAI 协议路由（CLAUDE.md "LLM Agent" 段明确），但类名仍叫 `AnthropicClient`，误导。 |
| **I-14** | P3 | `src/mail/sync_store.py:120,400` | `PRAGMA foreign_keys=ON` 重复设了两次（schema init 开头 + 结尾），无害但冗余。 |
| **I-15** | P3 | handoff `§2.2` 漏列 `src/utils/` 和 `src/calendar/` 在 §2.4 后续段落里都有；§2.4 漏列 `compare_llm_path.py / replay_recurring_invite.py / html_clipboard.py / keep_alive.py / test_office_converter.py / test_keep_alive.py` 等 | 不影响 CLI 设计但应补全 |

**P1 级（架构层面值得在 CLI 设计前先达成共识）**：I-01, I-02, I-03。
**P2 级（值得阶段 C 进一步检视）**：I-04 ~ I-11。
**P3 级（文档/命名/冗余）**：I-12 ~ I-15。

---

## 5. 已识别的"做得对"亮点

- ✅ **状态机单写入路径**：所有失败状态过 `_update_for_retry`，重试调度统一（`sync_store.py:719`）。
- ✅ **死信发件箱降级**：发件箱 fetch_failed 用尽 → skipped 而非 dead_letter，避免无意义告警（`sync_store.py:753-771`）。设计 + 文档（CLAUDE.md "死信降级例外"段）都到位。
- ✅ **v4 灰度 wrapper 三态明确**：开关 false / 开关 true + body 命中 / 开关 true + body miss（fallback）。`notion/sync.py:1004-1038` 三个分支都有 debug log，回滚干净。
- ✅ **EmailRepository 事务保证**：`commit_email_with_body` 落盘失败回滚 + 清理已写文件（line 366-372, 477-481）。
- ✅ **FTS5 trigger 三对称**：insert / delete / update 都同步维护 `email_body_fts`，无需手动 reindex；v5 启动一次性 reindex 历史 body 行（`sync_store.py:382-397`）。
- ✅ **dual-write 失败不阻断主流程**：`_maybe_dual_write_body` 只 warning（`new_watcher.py:502-504`）。回滚干净。
- ✅ **cid 还原对称设计**：`storage_payload_builder._rewrite_cid_to_local` 入库 + `notion/sync._restore_cid_in_body_html` 出库（line 814-842）。让 v2 既有 `_build_image_map / _handle_image` 原样工作。
- ✅ **handle_fetch_mail_content P99 latency 监控**：双路径 sqlite / applescript 分别打点，便于 dashboard 对比（handlers.py:74-94）。**这是 v4 监控做得最完善的位置**，其他 v4 路径应学。
- ✅ **指数退避重试**：`[60, 300, 900, 3600, 7200]` 时间窗合理，max 5 次（`sync_store.py:788`）。
- ✅ **AppleScript 性能优化**：`whose id is <int>` ~1s vs `whose message id is "<str>"` ~100s。架构核心收益。

---

## 6. 重构建议（用户拍板，**事实陈述之外**）

每条建议都是 **可选**，等阶段 D CLI 设计 RFC 时回看哪些是 CLI 必须前置的、哪些可以晚做。

### R-01：NotionSync 改 strict DI（阻塞 CLI 设计前置项之一）✅ Fixed in PR-1

**问题**：见 I-03 + I-10。3 套 repo 实例并存，配置默认值匹配纯属巧合。

**建议**：
- `NotionSync.__init__` 改为 **必传** `email_repo` 和 `sync_store`（不再 lazy）
- `NewWatcher` 持有 repo / sync_store 后传给 NotionSync 和 LLMRunner，单进程单实例
- CLI 入口（`scripts/resync_notion.py` 等）显式创建 `EmailRepository(db_path=cfg.sync_store_db_path, attachment_store=AttachmentStore(cfg.attachment_storage_dir))` 后注入

**收益**：
- 接口契约清晰，单元测试可注入 mock
- CLI 阶段 D 设计标准化（每个 `mailagent <cmd>` 都从同一处创建 repo）
- 配置一致性强保证（不再 silent 错配）

**成本**：
- 需要改 `NotionSync()` 所有 zero-arg 调用点 —— grep 大约 10+ 处
- 测试 fixtures 需要补依赖

**风险**：低。仅是构造函数变化，不动业务逻辑。

### R-02：`_handle_thread_relations` 切 SQLite SSoT ✅ Fixed in PR-1

**问题**：见 I-06。Phase 4 灰度后 thread relations 仍走 Notion API，错过 SSoT 收益。

**建议**：
- 新增 `EmailRepository.get_thread_members(thread_id, exclude_internal_id) → list[dict]`，复用 `sync_store.get_all_emails_by_thread_id`（line 1102）的语义
- `_handle_thread_relations` 优先从 SQLite 查，仅在 SQLite 缺数据时回 Notion 兜底（或彻底切 SQLite）
- 需要 `notion_page_id` 字段，已经在 `email_metadata` 表里（每个 synced 的邮件都有）

**收益**：
- 每封 thread 邮件少 1 次 Notion query（同步加速 + API quota）
- 反向同步 / 离线重传场景下不再依赖 Notion 可达
- 真正完成 Phase 4 "Notion 是镜像不是数据源"的目标

**成本**：
- 需要小心处理边缘情况（thread head 还没 sync 到 Notion 的暂态）
- 单测补对应 case

**风险**：中。thread relations 是用户能直观感知的功能，回归需要灰度。

### R-03：`fetched` 状态决断（删 or 实现）✅ Fixed in PR-1 (选项 A 删)

**问题**：见 I-02。死代码 + 文档不一致。

**两个选项**（二选一）：
- **A. 删**：从 sync_store.py 注释、architecture_v4、CLAUDE.md 状态机图删 `fetched`。把 7 状态描述改为 6 状态。最简单。
- **B. 实现**：在 `update_after_fetch` 里同时设 `sync_status='fetched'`（line 583 加 'sync_status' 已经在 allowed_fields 但调用方没传），表示"AppleScript 已成功获取，等待 Notion 同步"。区分 pending（雷达检测到尚未 fetch）和 fetched（已 fetch 未 Notion sync）。语义更精确，但需要相应改 retry queue / dashboard 显示。

**建议**：选 A。当前架构 `_sync_single_email_v3` 是 fetch → Notion 一气呵成，没有"已 fetch 但等 Notion"的真实中间态需要。

**风险**：低。仅文档/类型注释调整。

### R-04：CLI cwd 依赖解除 ✅ Fixed in PR-1

**问题**：见 I-05。`AttachmentStore.read` 依赖 `Path.cwd()`。

**建议**：
- `AttachmentStore.__init__` 把 `base_dir` 转 `Path(base_dir).resolve()`（除非已是绝对）
- 或者 `email_attachment.local_path` 入库时存绝对路径（向后兼容时新数据用绝对、老数据相对）

**收益**：CLI 阶段 D 可以从任何目录执行 `mailagent attachment download X`。

**成本**：迁移老数据可省（路径还能 join cwd 解析）；新代码切绝对即可。

**风险**：低。

### R-05：scripts/* 大扫除（CLI 设计前置）

**问题**：见 handoff §2.4 + I-15。47 个 scripts/* 杂糅 5 类。

**建议**（在阶段 D RFC 落地前先做一次清理）：

| 子目录 | 内容 |
|---|---|
| `scripts/archive/` | 一次性迁移：`migrate_sync_store_v3.py`, `backfill_internal_id.py`, `backfill_notion_id.py`（已完成历史使命） |
| `scripts/dev/` | 旧式 test_*.py / debug_*.py / inspect_*.py / check_*.py / cleanup_*.py / compare_llm_path.py | 
| `scripts/` 顶层 | 核心生产 CLI（保留）：`initial_sync, manual_sync, run_llm_on_email, sync_project_progress, resync_notion, backfill_email_body, backfill_derivatives, export_email_content, replay_recurring_invite` |
| `scripts/utils/` | shell helper：`create_reply_draft.sh, deploy-webhook.sh, toggle_keep_alive.sh, html_clipboard.py, keep_alive.py` |

**收益**：
- 阶段 D CLI 设计的 "整合范围"更清晰
- pm2 / docs 引用路径不大改（顶层 keep）
- 用户 `ls scripts/` 一眼看到生产入口

**成本**：移动文件 + 修 docs/CLAUDE.md 引用。

**风险**：低，但 PR diff 大。

### R-06：v4 灰度监控补齐

**问题**：见 F5.1 / I-11。

**建议**：
- `NotionSync` 加 stats counter：`{from_sqlite_hit, fallback_miss, fallback_error, total}` 
- `get_stats()` 暴露给 watcher.get_stats()，由 stats_reporter 上报 dashboard
- 类似 `handlers.py:74` 的 P99 latency 模式

**收益**：运维知道"灰度真正生效率"。

**风险**：低。

### R-07：移除"`fetched` 中间态"决定后，CLAUDE.md 同步收紧状态机文档 ✅ Fixed in PR-1

依 R-03 决定。

---

## 7. CLI 设计前置决策建议（阶段 D 入口）

完成本 Review 后进入阶段 D RFC 之前，建议先与用户拍板下面几条决策（每条都会直接影响命令树设计）：

| 决策点 | 选项 | 影响 |
|---|---|---|
| D1: NotionSync DI 是否前置（R-01） | (a) 先 refactor 再设计 CLI / (b) CLI 设计完一起改 | 影响 CLI 各命令是否能直接 `from src.notion.sync import NotionSync; NotionSync(repo=repo, sync_store=ss)` 注入 |
| D2: scripts/ 清理是否前置（R-05） | (a) 先清再设计 / (b) RFC 里 propose 清理方案 | 影响 RFC 是否同时给迁移路径表 |
| D3: CLI 主入口的 metadata 接口 | (a) 在 EmailRepository 加 `get_metadata()` 让 SSoT 单点 / (b) 接受 CLI 持有 repo+sync_store 两个对象 | 影响命令实现复杂度 |
| D4: CLI cwd 依赖（R-04） | (a) 先 fix AttachmentStore / (b) CLI 强制要求项目根执行 | 影响 CLI 用户体验 + agent 调用便利性 |
| D5: server mode 是否纳入 RFC | (a) CLI only（fork 慢） / (b) CLI + 可选 `mailagent serve` HTTP（agent 调更快） | 影响 RFC 范围 |

## 8. 推荐下一步

按 handoff §6 工作流，本 Review 完成应进入 §6.阶段 C 代码 review 或 §6.阶段 D RFC 起草。我的建议：

**A. 进阶段 C（代码层 review）**：用 `oh-my-claudecode:code-reviewer` 并行审 `notion/sync.py`（1745 行）/ `new_watcher.py`（889 行）/ `events/handlers.py`（856 行）/ `sync_store.py`（2153 行）四个高密度文件，补充阶段 B 的事实陈述并发掘行内 bug。
**B. 直接进阶段 D（CLI RFC 起草）**：基于本 Review 的 §6 决策与 §7 前置项，写 RFC，过阶段 C 留给 PR 实施时夹带 review pass。

两者不互斥。如果用户同意阶段 C 的并行 code-review，会显著扩大 review 报告体量，**但本 session 不会改任何代码**（用户的硬约束）。最终 PR 落地是另一个 session。

---

## 附录 A：Review 时点的环境快照

```bash
# git
$ git log --oneline -5
5d6cf7e docs(v4): Phase 4 → backend review + agent CLI handoff
dac9888 docs(v4): Phase 4 ship report + CLAUDE/architecture updates
8e0c64e feat(v4): SQLite-driven Notion uploader + resync CLI (Phase 4)
c261242 docs(v4): Phase 3→4 handoff (SQLite-driven Notion uploader spec)
c175ac8 feat(v4): FTS5 full-text search + agent webhook (Phase 3)

# db_version + 数据规模
$ sqlite3 data/sync_store.db "..."
metadata=8493  body=2397  fts=2397
attachments=8425  derived=365  notion_file_id=7

# 灰度开关
$ grep NOTION_READ_FROM_SQLITE .env
NOTION_READ_FROM_SQLITE=true

# 服务状态
$ pm2 status mail-sync
0  mail-sync  stopped   (≈ pid 8752 已退出)

# backfill 后台进程
$ ps aux | grep backfill_email_body | grep -v grep
chenyuanquan 29361 ... scripts/backfill_email_body.py --since-date 2026-03-01

# pytest
$ pytest tests/ -q --tb=no
......
1 failed, 294 passed, 77 warnings in 9.38s
# 失败用例：tests/notion/test_create_from_sqlite.py::TestV2WrapperRouting::test_disabled_by_default
# 原因：依赖 .env 真值（见 I-01），不是真实 bug
```

## 附录 B：核心模块行数（review 时点）

| 文件 | 行数 | handoff 期望 | 偏差 |
|---|---|---|---|
| `src/mail/sync_store.py` | 2153 | — | — |
| `src/notion/sync.py` | 1745 | ~1400 | +345 (Phase 4 新增 from_sqlite 路径) |
| `src/mail/new_watcher.py` | 889 | ~945 | -56 |
| `src/events/handlers.py` | 856 | ~855 | OK |
| `src/mail/applescript_arm.py` | 883 | — | — |
| `src/mail/reader.py` | 820 | ~700 | +120 |
| `src/mail/sqlite_radar.py` | 638 | — | — |
| `src/repository/email_repository.py` | 534 | — | — |
| `main.py` | 526 | — | — |
| `src/llm_agent/processor.py` | 345 | — | — |
| `src/llm_agent/runner.py` | 210 | — | — |
| `src/config.py` | 255 | — | — |

---

## 9. P1–P3 Audit 二轮（2026-05-16 PR-4 ship 后）

> **Audit 时点**: 2026-05-16，main HEAD = `9318ab7`（I-07 docs 更新）。
> **审计基线**: PR-1（已 ship, 修 I-01/I-02/I-03/I-05/I-06 + R-01..R-04/R-07） → PR-3（CLI rest, 487 passed） → PR-4（commit `4900dda`, CLI batch + R-06 v4_rollout, 612 passed） → I-07 拆 `notion/sync.py` (commit `76abc45`)。PR-5（`scripts/*` inline + thin wrapper）并行在跑，未 ship。
> **方法**: 对 §4 / §6 的每个 I-* / R-* 重新评估当前代码状态，标记 ✅ Fixed / 🟡 Partial / ⚠ Active / ⏸ Defer-PR5。**只读 verify，不动 src/**（PR-5 在改）。

### 9.1 P1 级（架构层）

| ID | 状态 | 证据 | 备注 |
|---|---|---|---|
| **I-01** | ✅ **Fixed** | PR-1 Commit 8 加 monkeypatch 隔离 `.env` | review 表中已标 |
| **I-02** | ✅ **Fixed** | PR-1 Commit 6 选项 A 删 `fetched` + 状态机回归测试 | 选 A 落地，文档已对齐 |
| **I-03** | ✅ **Fixed** | `src/notion/sync.py:29-44` `NotionSync.__init__(*, email_repo, sync_store)` strict DI，无 lazy 创建 | 11 调用点改造完成（commit 76abc45 拆分时未引入新 lazy 路径） |

**P1 全数解决 ✅**。

### 9.2 P2 级（接口 / 行为细节）

| ID | 状态 | 当前证据（2026-05-16 HEAD 9318ab7） | 处理时机 |
|---|---|---|---|
| **I-04** | ✅ **Fixed (2026-05-16 二修)** | docstring 澄清：key 是**原始** `AttachmentPayload.filename`（line 699 / 737 实测都用 `att.filename`，map 实际一致）；不是 sanitize 后的 `used_filename`。**修复方式**：`commit_email_with_body` docstring 明示 "Key 契约"段，调用方持有 AttachmentPayload list 即可查（不要用 sanitize 结果）。代码行为不动 — review 原始描述其实有误，map 一直是一致的。 | 655 passed 持平 |
| **I-05** | ✅ **Fixed** | `src/repository/attachment_store.py:45` `self.base_dir = raw_base_dir.resolve()`；L137/L144 `project_root = self.base_dir.parent.parent`，解除 `Path.cwd()` 依赖 | R-04 在 PR-1 Commit 5 落地，**CLI 已可从任意目录执行** |
| **I-06** | ✅ **Fixed** | review 表已标 PR-1 Commit 4 修 — SQLite SSoT 优先 + Notion fallback | （未深度复测 thread relations 实际 SQL，依赖原 review 标记 + git log） |
| **I-07** | ✅ **Fixed** | `src/notion/` 5 文件拆分：`sync.py` 409 facade + `pages.py` 1145 + `threads.py` 281 + `queries.py` 378 + `_common.py` 122 = 2335 行净增（含必要的 delegate boilerplate ~80 行）；public API 11 调用点零改动；612 passed 持平 | commit `76abc45`；CLAUDE.md "Notion 模块" 段已对齐 |
| **I-08** | ⚠ **Active (设计选择)** | `src/events/handlers.py:630` `if body is None or body.body_format == "empty" or not body.markdown: return None`；注释明示 "让 AppleScript 路径接手"。纯附件邮件每次 `fetch_mail_content` 都触发 ~1s AppleScript fallback。 | **保持现状**：原 review §4 自标 "是设计还是 bug 看视角"。改进方向是给 `email_body` 加 `fetched_but_empty` 标志位区分 "真空" vs "未双写"，避免无意义 fallback。**估算工时 ~2h（含 schema + handler + 单测）**。不在 PR-5 范围；可独立 PR 修。 |
| **I-09** | ⚠ **Active (T-06 兜底)** | `src/repository/email_repository.py:788-799` `delete_email_full`：先 `BEGIN/DELETE/commit()`（CASCADE 触发 body+attachment 行），后 `self.attachment_store.delete_email_dir(internal_id)`。**两阶段非原子**：DB commit 后文件删失败 → 孤儿目录。 | **保持现状**：T-06 orphan cleanup CLI（未来工作）兜底；用户原决策"接受"。修复方案：把 `delete_email_dir` 移到 `BEGIN` 内 try block，文件删失败 → DB rollback。代价：文件 I/O 进 DB 事务窗口（锁时间变长）。**ROI 低**，不推。 |
| **I-10** | 🟡 **Partial (NotionSync 已收敛)** | EmailRepository 创建点 3 处（grep 验证）：`src/mail/new_watcher.py:122`、`src/llm_agent/runner.py:78`、`src/cli/context.py:98`。原 review 写的 "NotionSync.\_repo lazy 创建" 路径已**消除**（I-03 strict DI 修后），所以 silent 错配风险**降一半**。但 "单进程单实例" 目标仍未达 — CLI 入口 `CliContext` 是 PR-2 新增独立实例。 | **⏸ Defer**：CliContext 创建自己的 repo 是合理设计（CLI 单次调用进程独立）；只有 `new_watcher` ↔ `LLMRunner` 在同一长跑进程内才有共享意义。是否进一步收敛取决于性能 profile，**当前没有信号要修**。 |
| **I-11** | ✅ **Fixed** | PR-4 US-008 落地 R-06：`NotionSync` 加 `_route_hit/_miss/_error/_latency_samples` (deque maxlen=10) + `record_route_hit/miss/error`；60s flush 到 `v4_rollout_stats` 表；`admin stats --section v4_rollout` 暴露 p99/hit_rate；schema `admin-stats-v4-rollout.schema.json` 落位 | I-07 拆分后 `RolloutMetrics` 抽到 `_common.py`，facade 共享单实例（lazy init 兼容 `__new__` bypass hook） |

**P2 进展（2026-05-16 二修后）**：4 ✅ Fixed（I-05/06/07/11 + 新增 I-04 docstring 澄清）+ 1 🟡 Partial（I-10）+ 2 ⚠ Active（I-08/09，"接受现状"设计选择）。

### 9.3 P3 级（文档 / 命名 / 冗余）

| ID | 状态 | 当前证据 | 处理时机 |
|---|---|---|---|
| **I-12** | ⚠ **Active (路径已边缘化)** | `src/mail/sync_store.py:879-944` `_save_email_compat` 仍保留：`if internal_id is None and message_id: → _save_email_compat`. v3 主路径（SQLite radar 来的 email）永远带 `internal_id`，不触发兼容代码。唯一可能 trigger 是老脚本（`scripts/migrate_sync_store_v3.py` 之类 archive 候选）调 `save_email({message_id: ..., internal_id: None})`. | **保持现状**：PR-5 US-011 把这些老脚本归 `scripts/archive/`（详见 `docs/r05-scripts-cleanup-design.md` §3.4）后，`_save_email_compat` 被触发的概率 = 0。可在 PR-7（未来 schema v7）时清掉 + 加 deprecation。 |
| **I-13** | ✅ **Fixed (2026-05-16 二修)** | `class AnthropicClient` → `class LLMClient`（`src/llm_agent/client.py:110`）；docstring 同步更新；改 5 处 import 调用点（`__init__.py` / `processor.py` × 2 / `test_processor.py` / `scripts/run_llm_on_email.py` × 2）。无 backward-compat alias（按 CLAUDE.md 指南 "Avoid backwards-compatibility hacks"）。 | 62/62 llm_agent tests passed + mail-sync 重启加载 OK |
| **I-14** | ✅ **Fixed (2026-05-16 二修)** | `src/mail/sync_store.py:_init_database` 末尾的 `cursor.execute("PRAGMA foreign_keys = ON")` 删除。conn 在 `_get_connection:121` 创建时已设过 PRAGMA — 末尾重设是冗余。删 2 行（注释 + 调用）。 | 136 mail+repo tests passed |
| **I-15** | 🟡 **Partial** | review 文档自己 §1 列出来 handoff 偏差；`docs/r05-scripts-cleanup-design.md` §1.1 给出当前准确 45 数。但 `docs/phase4-handoff-backend-review-and-agent-cli.md` 本体没回改（"43 个脚本"等遗留陈述）。 | **保持现状**：handoff 文档是历史快照性质，不必回改；新文档（CLAUDE.md / r05-cleanup-design / PR-5 PRD）已对齐准确数据。 |

### 9.4 R-* 重构建议状态

| ID | 状态 | 证据 |
|---|---|---|
| **R-01** NotionSync strict DI | ✅ Fixed (PR-1 Commit 3) | `notion/sync.py:29` `__init__(*, email_repo, sync_store)` |
| **R-02** thread relations 切 SQLite | ✅ Fixed (PR-1 Commit 4) | review 表已标 |
| **R-03** `fetched` 状态决断 | ✅ Fixed (PR-1 Commit 6, 选项 A 删) | review 表已标 |
| **R-04** CLI cwd 依赖解除 | ✅ Fixed (PR-1 Commit 5) | I-05 证据 |
| **R-05** scripts/* 大扫除 | ✅ Fixed (PR-5 14 commits ship 2026-05-16) | 顶层 13 thin wrapper + 5 保留 + dev/ 25 + archive/ 4 = 45；650 passed |
| **R-06** v4 灰度监控补齐 | ✅ Fixed (PR-4 US-008 + 2026-05-16 二修 task GC bug) | 见 §9.6 新发现：PR-4 ship 后 mail-sync 实跑 3h 0 flush（asyncio create_task 弱引用 GC）；1 行 fix 后验证 60s 第一条 row 写入 |
| **R-07** CLAUDE.md 状态机收紧 | ✅ Fixed (PR-1) | review 表已标 |

**R-* 进展（PR-5 ship 后）**：7 ✅ Fixed（全数解决）。

### 9.5 总结

#### 修复进展（PR-5 ship + 2026-05-16 二修后）

| 级 | 总数 | ✅ Fixed | 🟡 Partial | ⚠ Active | ⏳ Pending |
|---|---|---|---|---|---|
| P1 (I-01..03) | 3 | 3 | 0 | 0 | 0 |
| P2 (I-04..11) | 8 | 5 | 1 | 2 | 0 |
| P3 (I-12..15) | 4 | 2 | 1 | 1 | 0 |
| R-* | 7 | 7 | 0 | 0 | 0 |
| **总计** | **22** | **17** | **2** | **3** | **0** |

**77% 完全修复** + 9% 部分修复 + 14% Active（全部是"接受现状"设计选择）+ 0% Pending。

#### 当前仍需关注

无 P0/P1/P2 阻塞。原 I-08 经实测数据评估后归"不修建议"（见下）。

#### 不修建议

- **I-08 empty body fallback AppleScript**：原描述 "纯附件邮件每次 fetch_mail_content 慢 1s"。**2026-05-16 实测**：v4 双写 6030 封 body 中 `body_format='empty'` 仅 29 封（0.5%），且**全部是 Outlook 会议响应通知**（"已接受 / 已拒绝 / 已取消" 自动邮件，subject 即全部信息，0 附件），**不是真的"纯附件邮件"**。webhook 查询这类邮件的频率近 0，多花 1s 跑 AppleScript fallback 用户感知 ~0。决定：保持现状。
- **I-09 delete_email_full 非原子**：T-06 cleanup 兜底，修反而引入"文件 I/O 进 DB 事务"风险，ROI 负。
- **I-10 多套 EmailRepository**：CliContext 独立实例是合理设计（CLI 短进程）；只有同长跑进程内合实例才有共享意义。
- **I-12 `_save_email_compat`**：路径已边缘化（v3 主路径不触发）；PR-5 US-011 把 archive 老脚本后概率 = 0。可在 PR-7（未来 schema v7）时清掉 + 加 deprecation。
- **I-15 handoff 文档遗漏**：历史快照不必回改；新文档已对齐。

### 9.6 2026-05-16 二修 round（PR-5 ship 后同日落地 5 项）

PR-5 ship（650 passed）后同日做的修复，全部基于 §9 audit 的"非阻塞但值得清理"项：

| 项 | 修复内容 | 验收 |
|---|---|---|
| **R-06 task GC bug**（新发现） | **生产实测**：mail-sync online 3h，`v4_rollout_stats` 表 0 row（预期 ~180）；admin stats CLI 自动 fallback `_source=no_data_yet` 掩盖问题。**根因**：`src/mail/new_watcher.py:251` `asyncio.create_task(self._flush_v4_rollout_stats_loop())` 未保存 task 引用，Python 3.11 弱引用 GC 触发。**修复**：`self._rollout_flush_task = asyncio.create_task(...)`。**1 行 + 1 行注释**。 | mail-sync 重启后 16:00:43（启动 60s 内）写入第一条 row id=3；admin stats 不再 `no_data_yet`；R-06 功能真正落地 |
| **I-04 docstring 澄清** | review 原描述 "key 是原始 filename 但 SQLite 存 sanitize 后" 其实 map 一直是一致的（line 699 + 737 实测都用 `att.filename`）。修：`commit_email_with_body` docstring 加 "Key 契约"段，明示 key = 原始 AttachmentPayload.filename，不是 sanitize 后 `used_filename`。**纯文档修订，零代码改动**。 | 655 passed 持平 |
| **I-13 LLMClient rename** | `class AnthropicClient` → `class LLMClient`（`src/llm_agent/client.py:110`）；docstring 改 + 5 处 import 调用点更新（`__init__.py` / `processor.py` × 2 / `test_processor.py` / `scripts/run_llm_on_email.py` × 2）；**无 backward-compat alias**（按 CLAUDE.md 指南 "Avoid backwards-compatibility hacks"）。 | 62 llm_agent + 655 全集 passed；mail-sync 重启加载 OK |
| **I-14 PRAGMA 删冗余** | `src/mail/sync_store.py:_init_database` 末尾删 `cursor.execute("PRAGMA foreign_keys = ON")`（conn 在 `_get_connection:121` 已设过）。删 2 行（注释 + 调用）。 | 136 mail+repo passed；655 全集 passed |
| **R-05 scripts cleanup** | **PR-5 14 commits ship**（72a1f65..372f494）落地。scripts/ 顶层 41 → 11 thin wrapper + 5 保留；dev/ 25；archive/ 4。落地与 `docs/r05-scripts-cleanup-design.md` 基本一致，差异 3 项 PR-5 决策更精准（`manual_sync / export_email_content` 归 dev 而非 wrapper；`poc_markdown_api` 归 archive 而非 dev）。 | 612 → 650 passed（+38 净增） |

**总数变化**：

- 原 §9 audit：13 Fixed + 2 Partial + 6 Active + 1 Pending
- 二修 round 后：17 Fixed + 2 Partial + 3 Active + 0 Pending
- 净修复 +4（I-04 / I-13 / I-14 + R-05），新发现 1 (R-06 GC bug) 也已修

**新发现 R-06 task GC bug 的教训**：

PR-4 R-06 落地时所有单测都 pass（PR-4 ship 612 passed），但**生产实测**才能发现 task GC 问题——单测里 task 通常显式 `await` 或 mock event loop，不会复现 fire-and-forget + 60s sleep 的 GC 时序。这类 bug 只能靠"灰度后看真实指标"发现。**建议**：未来 fire-and-forget asyncio task 强制 review checklist 一条 "task ref 保存"。

---

> 本 Review 由 Claude Code Opus 4.7 (1M context) 完成于 2026-05-16。不动代码、不动 git、仅产出 markdown + 修 handoff 文档。如需进入阶段 C / D 请明确选择。
>
> §9 二轮 audit 追加于 2026-05-16 同日（PR-4 ship 后 + PR-5 启动前）。基线 HEAD `9318ab7`，对应 §4 全表 + §6 全表 verify。
>
> §9.6 二修 round 追加于 2026-05-16 PR-5 ship 后（commit `372f494`）。基线 HEAD = PR-5 末位，pytest 655 passed。本轮净修 4 项原 Active + 1 项新发现 R-06 GC bug。下一轮 audit 建议在 **I-08 修复后**（或下次大改时）刷新。
