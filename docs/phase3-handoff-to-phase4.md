# Phase 3 → Phase 4 Handoff（v4 SQLite SSoT 重构）

> **Phase 3 上线日期**: 2026-05-15
> **Phase 3 状态**: ✅ 全部完成（FTS5 + search API + agent webhook + 28 单测 + 文档）
> **Phase 4 状态**: ⏳ 待办（下一 session 入口点）
> **前置文档**:
> - [`docs/phase3-complete.md`](./phase3-complete.md) — Phase 3 完整 ship 报告
> - [`docs/architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) — 完整架构（§5 Phase 4 简述）
> - [`docs/phase2-handoff-to-phase3.md`](./phase2-handoff-to-phase3.md) — 上一阶段 handoff（obsolete，仅参考）

---

## 1. TL;DR

Phase 1-3 已让 SQLite 成为下游消费者（LLM / fetch_mail_content / search）的 SSoT。**但 Notion uploader 还是从 in-memory `Email` 对象 + `/tmp/{md5}/` 临时文件上传** —— 这条最关键的写入路径还没归一。

**Phase 4 要做**：让 `notion/sync.py` 切换为从 SQLite + `data/attachments/{int_id}/` 读取，新增 `create_email_page_from_sqlite(internal_id)` 入口；老 `create_email_page_v2(email)` 退化为 wrapper（双源兼容期）。完成后架构归一，`scripts/resync_notion.py` 可纯基于 SQLite 重传，不再需要 AppleScript 重抽。

---

## 2. Phase 4 可以马上开始吗？

**可以，但建议先观察 Phase 3 + backfill 一段时间。**

理由：
- Phase 3 改动面相对小（schema + repo + handler），但 Phase 4 要动 `notion/sync.py` 这条线上的核心代码（~1359 行，承担线程关系 / 内联图 / 会议邀请 / Office 转换 / 反向同步等多重责任），风险更高
- backfill 跑完前（当前 ~16% 覆盖率 1000/6131）`create_email_page_from_sqlite` 只能处理双写后的新邮件；老邮件 resync 仍需走 AppleScript
- Phase 3 是只读路径上线，对生产无副作用；Phase 4 是写入路径切换，必须充分验证

**最佳节奏**：
1. 先让 backfill 跑完（预估 ~10 小时）→ SQLite 已是完整 SSoT
2. 写 Phase 4 主体代码 + 单测，但**不切默认路径**（用 `NOTION_READ_FROM_SQLITE=false` 开关）
3. 抽样人工对比新旧两条路径在 Notion 上渲染的差异（HTML 块、内联图、附件顺序）
4. 单封灰度（手动跑 `--use-sqlite-path`）→ 100 封灰度 → 默认切

---

## 3. Phase 3 落地清单（已 ship）

### 3.1 提交（待 push）
```
<待 commit> docs(v4): Phase 3→4 handoff
<待 commit> feat(v4): FTS5 search + agent webhook (Phase 3 ship + docs)
298a6dc     docs(v4): Phase 2→3 handoff (FTS5 + agent search tool spec)
aab383a     docs(v4): Phase 2 ship report + ops guide
```

9 个本地 commits（Phase 1 4 + Phase 2 3 + Phase 3 2）**未 push**，按用户偏好。

### 3.2 接口变更（Phase 4 可消费）
- `EmailRepository.search_email_bodies(...)` — FTS5 全文搜索；Phase 4 不会用到，但同一个 repo 实例已有 attachment / body 读接口可复用
- `email_body_fts` 虚表 + 3 个 trigger — 透明工作，Phase 4 不需要关心
- 没有破坏性变更：DB_VERSION 4→5 是兼容升级，老代码读 v5 DB 完全无感

### 3.3 测试覆盖
- 274/274 全套 pytest passed（Phase 2 246 + Phase 3 +28）

---

## 4. 当前生产状态

```bash
# DB 状态
sqlite3 data/sync_store.db "
  SELECT 'db_version=' || (SELECT value FROM sync_state WHERE key='db_version')
    || ' metadata=' || (SELECT COUNT(*) FROM email_metadata)
    || ' body=' || (SELECT COUNT(*) FROM email_body)
    || ' fts=' || (SELECT COUNT(*) FROM email_body_fts)
    || ' attachments=' || (SELECT COUNT(*) FROM email_attachment)"
```

最后一次验证（2026-05-15 22:58）：`db_version=5 metadata=8493 body=985 fts=985 attachments=3543`

- body / fts 行数一致 → trigger 工作正常
- attachments 3543 行 ≈ 985 × 3.6/邮件，合理
- backfill 还在跑（用户脚本 PID 29361，`scripts/backfill_email_body.py --since-date 2026-03-01`）

**pm2 状态**: mail-sync `stopped`（用户为 backfill 让路）。Phase 4 开工前需 backfill 完 + pm2 重启。

---

## 5. Phase 4 工作清单

### 5.1 P4-01 — `create_email_page_from_sqlite(internal_id)` 新入口

**入口**: `src/notion/sync.py`，与 `create_email_page_v2` 并列

```python
async def create_email_page_from_sqlite(
    self,
    internal_id: int,
    *,
    repo: EmailRepository,
    sync_store: SyncStore,
    meeting_invite: Optional['MeetingInvite'] = None,
) -> Optional[str]:
    """从 SQLite 读取 body + attachments 并创建 Notion 页面.

    与 create_email_page_v2 的不同:
        - 不接受 in-memory Email 对象
        - attachments 从 email_attachment.local_path 读盘（不是 /tmp/{md5}/）
        - body_html 从 email_body.body_html 取（已 cid 重写过）
        - metadata 从 email_metadata 取（subject / sender / date 等）
        - 上传完成后通过 repo.update_notion_links 回写 file_id / block_id
    """
```

**关键子任务**:
- 从 `repo.get_body(internal_id)` 拿 EmailBodyRecord（html / markdown / format / has_inline_images）
- 从 `repo.get_attachments(internal_id)` 拿 list[AttachmentRecord]（id / filename / local_path / is_inline / content_id / derived_from / derived_format）
- 从 `sync_store.get(internal_id)` 拿 metadata（subject / sender / from_name / to / cc / date / thread_id / mailbox / is_read / is_flagged）
- 把上面三块拼出 Notion properties + blocks

### 5.2 P4-02 — `_upload_attachments_from_sqlite`

替换 `_upload_attachments`（基于 email.attachments[].path）：

```python
async def _upload_attachments_from_sqlite(
    self,
    attachments: list[AttachmentRecord],
    repo: EmailRepository,
) -> tuple[dict[int, str], list[int]]:
    """从 SQLite 读字节、上传到 Notion，返回 {attachment_id: file_upload_id} 映射.

    不再用 /tmp 路径；直接 repo.get_attachment_bytes(att.id)，content 为空时 skip.

    derived_from 的处理:
        - Office 转换产物（pdf/csv）已经作为独立 email_attachment 行存在
        - 不再在这里调 convert_office_attachment（v4 双写阶段已转）
        - 直接当普通附件上传
    """
```

**`_build_image_map_from_sqlite`** 替代 `_build_image_map`：v4 body_html 里 inline image 的 src 已经是 `attachments/{int_id}/{filename}`（见 `src/repository/storage_payload_builder.py:_rewrite_cid_to_local`），需要再次映射到刚上传的 Notion file_upload_id。

### 5.3 P4-03 — 上传后回写 notion_file_id / notion_block_id

上传成功后：
```python
file_id_map = {att.id: file_upload_id for att, file_upload_id in zip(atts, uploaded)}
repo.update_notion_links(internal_id, file_id_map=file_id_map)
# block_id_map 等 _create_page_with_blocks 返回 children 中 image/file block id 再回填
```

**好处**：未来反向同步可以走 `email_attachment.notion_file_id` 查找已上传文件不重传；T-06 orphan cleanup 也可基于这个判断。

### 5.4 P4-04 — `create_email_page_v2` 改为 wrapper

```python
async def create_email_page_v2(self, email: Email, meeting_invite=None) -> Optional[str]:
    """老入口：双写流程会先 commit SQLite，所以 email.internal_id 在 SQLite 已有 body/attachments.
    
    如果 NOTION_READ_FROM_SQLITE=true（默认）且 SQLite 命中 → delegate 到 create_email_page_from_sqlite.
    否则走老路径（向后兼容）.
    """
```

**双源期**：开关 `NOTION_READ_FROM_SQLITE=true|false` 控制；默认 false（保守），等灰度验证完再切 true。

### 5.5 P4-05 — `scripts/resync_notion.py` 重写

新版基于 SQLite，不调 AppleScript：
```bash
python scripts/resync_notion.py --internal-id 12345
python scripts/resync_notion.py --range 10000-10100 --replace-existing
```

参考样板：`scripts/backfill_email_body.py` 的 CLI 设计。

### 5.6 P4-06 — 单测 + 回归

| 测试 | 覆盖 |
|---|---|
| `tests/notion/test_create_from_sqlite.py`（新） | 主流程 / 缺 body / 缺 attachment / inline image cid 重映射 / 上传失败回滚 / 上传后回写 file_id |
| `tests/notion/test_v2_wrapper.py`（新） | wrapper 路由：NOTION_READ_FROM_SQLITE=true 且 body 存在 → 新路径；body 缺失 → 老路径 |
| 抽样人工对比 | 选 10 封新邮件，分别用 v2 / from_sqlite 各跑一次，diff Notion 上的 properties + blocks |

### 5.7 工时估计

- P4-01 + P4-02：1 天（最复杂的部分，HTML cid 重映射 + image_map 是坑）
- P4-03 + P4-04：0.5 天（接口已就位，主要拼装）
- P4-05：0.5 天
- P4-06：0.5 天（单测）+ 1 天（人工验证）

**总计：3-4 天**，比 Phase 3 重得多。建议拆 2-3 个 session 完成。

---

## 6. Phase 4 关键文件入口（速查）

### 要改的
- `src/notion/sync.py:775-887` — `create_email_page_v2`，新增 `create_email_page_from_sqlite` 兄弟方法
- `src/notion/sync.py:43-86` — `_upload_attachments`，新增 `_upload_attachments_from_sqlite`
- `src/notion/sync.py:311-384` — `_build_image_map`，新增 `_build_image_map_from_sqlite`（cid 重写产物 → file_upload_id）
- `src/notion/sync.py:88-150` — `_convert_office_attachments` 可能简化（v4 dual-write 已转）
- `src/config.py` — 加 `NOTION_READ_FROM_SQLITE` 开关（默认 false 灰度期，验证后改 true）
- `scripts/resync_notion.py` — 全新或大改（看现状）
- `tests/notion/`（如不存在则新建目录）

### 不要动的（前面 Phase 已就位）
- `src/repository/email_repository.py` — 接口完整可用，包括 `update_notion_links`
- `src/repository/storage_payload_builder.py` — cid → `attachments/{int_id}/{filename}` 已落地
- `src/mail/new_watcher.py` — 双写流程不变；只需确保 Notion sync 路径接受新入口（可能要小改 `_sync_single_email_v3`）

---

## 7. 注意事项 / 风险

### 7.1 HTML cid 二次映射（最高风险）

v4 把邮件 HTML 的 `<img src="cid:xxx">` 重写为 `<img src="attachments/{int_id}/{filename}">` 存在 `email_body.body_html`。但 Notion 渲染 image block 需要 `file_upload_id`（已上传到 Notion 的 ID）。

**两步映射**：
```
原 HTML:    <img src="cid:logo01@host">
SQLite存:    <img src="attachments/53675/logo.png">
Notion渲染:  Notion image block { type: 'file_upload', file_upload_id: 'xxx' }
```

实施时需要：
- `_build_image_map_from_sqlite` 扫描 body_html 找 `attachments/{int_id}/{filename}` 模式
- 在已上传附件里找 `local_path` 匹配 `data/attachments/{int_id}/{filename}` 的，取其 `notion_file_id`
- HTML converter 把 `<img src="attachments/...">` 转成 file_upload_id 的 image block

如果 image_map 缺一个，新路径上的内联图会变成"裸 URL 渲染"或丢失。**抽样对比时重点检查内联图**。

### 7.2 Office 转换 derived 行

v4 双写时，`_convert_office_attachments` 会把 docx→pdf / xlsx→csv 的转换产物存为独立 `email_attachment` 行（`derived_from` 自指）。Phase 4 上传时：
- 都当普通附件上传（不再调用 `convert_office_attachment`）
- 顺序：可能要让 derived 行紧跟原始行（UI 上 docx 后面跟着 pdf）

### 7.3 线程关系 / 周期会议 / Parent Item

`create_email_page_v2` 的尾部 `_handle_thread_relations` + meeting 检测仍要保留 —— 这些和 body / attachments 解耦，Phase 4 可原样调用。

### 7.4 反向同步路径不变

`reverse_sync.py` / `handle_completed` 等已经走 metadata + Notion API，不依赖 attachments 文件，Phase 4 无影响。

### 7.5 backfill 期间灰度切换

如果 Phase 4 期间还在 backfill：
- 默认 `NOTION_READ_FROM_SQLITE=false` 不影响生产新邮件 sync
- backfill 的邮件已经在 Notion（老路径建的），新路径不需要重传
- 等 backfill 完，切 true，新邮件走新路径

---

## 8. Phase 4 完成后

1. **Phase 5** Web / Electron 前端（独立项目，本仓库 scope 外）
2. **T-01** Notion sync 迁 Markdown API —— Phase 4 拿到 `body_markdown` 在手，直接 `PATCH /pages/:id/markdown` 比 children blocks 更简洁
3. **T-06** 附件 orphan cleanup CLI
4. **架构归一**：Notion 真正成为"镜像"，所有出口都从 SQLite 拉

---

## 9. 新 session 启动验证命令

```bash
# 1. Phase 3 完成状态
git log --oneline -10
# 期望看到 Phase 3 ship + Phase 3→4 handoff commit

# 2. DB 状态（Phase 3 schema）
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"
# 期望: 5

# 3. FTS 工作正常
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body_fts"
# 期望: 与 email_body 一致

# 4. 单测全绿
source venv/bin/activate && pytest tests/ -q
# 期望: 274 passed

# 5. backfill 状态
ps aux | grep backfill_email_body | grep -v grep
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body"

# 6. 生产服务
pm2 status mail-sync
# backfill 跑完后应该 online
```

---

> **新 session 接手指令**：
>
> "继续 Phase 4 的实施工作。前置 handoff 文档：`docs/phase3-handoff-to-phase4.md`。先按 §9 跑验证命令确认环境，特别关注 backfill 是否已完成（影响灰度策略）。从 §5 P4-01 开始实施，**默认保持 NOTION_READ_FROM_SQLITE=false 灰度，不切默认路径**，等单测 + 人工 diff 验证完再切。"
