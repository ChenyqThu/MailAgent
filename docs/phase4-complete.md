# Phase 4 完成报告（v4 SQLite SSoT — Notion uploader 改读 SQLite）

> **Phase 4 ship 日期**: 2026-05-16
> **范围**: P4-01/02 (`create_email_page_from_sqlite` + 5 个 SQLite 辅助方法) · P4-03 (上传后 `notion_file_id` 回写) · P4-04 (`create_email_page_v2` 灰度路由 + `NOTION_READ_FROM_SQLITE` 开关) · P4-05 (`scripts/resync_notion.py`) · P4-06 (21 个新单测 + 回归 295/295) · 附加 (`scripts/backfill_derivatives.py` 补救工具 + `backfill_email_body.py` Office 转换告警加固)
> **前置文档**: [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) · [`phase3-complete.md`](./phase3-complete.md) · [`phase3-handoff-to-phase4.md`](./phase3-handoff-to-phase4.md)

---

## 1. TL;DR

Notion uploader 终于不再依赖 in-memory `Email` + `/tmp/{md5}/`，新增 `create_email_page_from_sqlite(internal_id, repo, sync_store)` 直接从 SQLite SSoT 重建邮件页：

- **沿用 v2 流程**：把 SQLite 附件物化到临时目录、把 v4 body_html 里的相对路径 `attachments/{int_id}/{filename}` 还原成 `cid:{原 content_id}`，让既有 `_upload_attachments` / `_build_image_map` / `_handle_image` / `EMLGenerator` 全部原样工作 → 新旧两条路径 Notion 渲染产物等价，diff 验证有保证
- **灰度切换**：v2 wrapper 走 `NOTION_READ_FROM_SQLITE` 开关；默认 `false`，对生产新邮件 sync 无副作用；切 `true` 后 v2 + resync 都统一走 SSoT
- **CLI**：`scripts/resync_notion.py` 支持 `--internal-id` / `--internal-ids` / `--range` / `--replace-existing` / `--dry-run`，幂等 + 失败熔断 + 进度速率
- **附件链路完整**：上传完成回写 `email_attachment.notion_file_id`，为 T-06 orphan cleanup / 反向同步打底
- **生产对照**：3 封灰度切换实测（53674 / 53675 / 53677）—— properties / 内联图 / 附件全部正确，Office derived 缺失个例靠 `backfill_derivatives.py` 单独补齐

---

## 2. 改动清单

### 2.1 新增 / 修改文件

| 文件 | 改动 |
|---|---|
| `src/notion/sync.py` | NotionSync 支持 lazy `_repo` / `_sync_store`；新增 `create_email_page_from_sqlite()` + 5 个辅助方法（`_V4_ATTACHMENT_SRC_RE` / `_restore_cid_in_body_html` / `_materialize_attachments` / `_parse_iso_to_beijing` / `_build_email_from_sqlite` / `_build_file_id_map` / `_ensure_sqlite_resources`）；`create_email_page_v2` 顶部加灰度路由 |
| `src/config.py` | 新增 `notion_read_from_sqlite: bool = False`（`NOTION_READ_FROM_SQLITE` 环境变量） |
| `scripts/resync_notion.py` | **新建** —— 基于 SQLite 重传 Notion 邮件页面的 CLI |
| `scripts/backfill_derivatives.py` | **新建** —— 扫 `email_attachment` 补 Office 衍生附件（PDF/CSV）；不动现有 row 只追加 derived row |
| `scripts/backfill_email_body.py` | 加 "期望 vs 实际衍生数" 对比告警 —— 避免 `_convert_office_attachments` silent fail |
| `tests/notion/test_create_from_sqlite.py` | **新建** —— 21 个测试（cid 还原 / 附件物化 / Email 重建 / 端到端 / 重复处理 / wrapper 路由三种状态） |
| `tests/notion/__init__.py` | 新建空 init（包标记） |
| `docs/phase4-complete.md` | 本文档 |
| `CLAUDE.md` / `docs/architecture_v4_sqlite_ssot.md` | Phase 推进表更新（待提交） |

**总单测**: 295 passed（Phase 3 274 + Phase 4 +21）。

### 2.2 v2 wrapper 灰度路由

`create_email_page_v2` 顶部加 5 行路由逻辑：

```python
from src.config import config as app_config
if app_config.notion_read_from_sqlite and email.internal_id:
    try:
        repo, sync_store = self._ensure_sqlite_resources()
        if repo.get_body(email.internal_id) is not None:
            return await self.create_email_page_from_sqlite(
                email.internal_id, repo=repo, sync_store=sync_store,
                meeting_invite=meeting_invite,
                calendar_page_id=calendar_page_id,
                skip_parent_lookup=skip_parent_lookup,
            )
        # body miss → fallback legacy
    except ValueError:
        pass  # 走老路径
    except Exception as e:
        logger.warning(...)
        # 异常 → 走老路径
# 老路径原样保留 ...
```

**三种状态**:
| 开关 | SQLite body | 行为 |
|---|---|---|
| false | 任意 | 老路径（默认，灰度期保护） |
| true | 命中 | from-sqlite 路径 |
| true | miss | 老路径 fallback（适配 backfill 未覆盖的历史邮件） |

### 2.3 v4 SSoT 路径设计要点

#### cid 还原（最高风险点）

`src/repository/storage_payload_builder.py:_rewrite_cid_to_local` 把入库时的 `<img src="cid:logo@host">` 重写为 `<img src="attachments/53675/logo.png">`。但 Notion 渲染 image block 需要 `file_upload_id`，所以必须双向映射：

```
入库   原 HTML <img src="cid:logo@host">      ──┐
                                                ▼
SQLite 存的  <img src="attachments/53675/logo.png">  ◄── 浏览器/Web 端直接读盘
                                                ▲
出库   create_email_page_from_sqlite 把它再还原成 cid → _build_image_map 命中 → file_upload_id
```

实现：`_restore_cid_in_body_html(html, attachments)` 用正则把 `attachments/{int_id}/{filename}` 替换回 `cid:{content_id}`，filename → content_id 映射来自 `email_attachment` 表（要求 `content_id` 不为空）。映射缺失保留原路径，`_handle_image` 进 "unsupported src" 分支吐占位 callout —— 不致命。

**好处**：`_build_image_map` / `_handle_image` 不需要任何改动；新旧两条路径产物完全等价。

#### Office 转换跳过

v4 dual-write 阶段已经把 `docx→PDF` / `xlsx→CSV` 衍生附件作为独立 `email_attachment` 行入库（`derived_from` 自指 FK 关联）。`create_email_page_from_sqlite` 直接把所有 attachment（含 derived）当普通附件上传，**不再调用** `_convert_office_attachments`。

#### .eml 文件生成

`EMLGenerator.generate(email)` 按 `attachment.path` 读盘 → 物化阶段已把 SQLite 附件落到临时目录、`attachment.path` 指向新位置 → EMLGenerator 原样工作。

#### Thread relations

`from_sqlite` 路径在 `skip_parent_lookup=False` 时调 `_handle_thread_relations(page_id, email)` —— 与 v2 路径同。`resync_notion.py` CLI 默认 `skip_parent_lookup=True`（diff 验证用途），生产 sync 路径不传则保留默认 `False`，正常建关系。

#### 上传后 notion_file_id 回写（P4-03）

`_build_file_id_map(uploaded_attachments, att_records)` 按 filename 关联，调 `repo.update_notion_links(internal_id, file_id_map=...)`。

**用途**：未来 T-06 orphan cleanup（扫 `email_attachment.notion_file_id IS NULL AND created_at > X` 找悬挂附件）、反向同步（用 `notion_file_id` 直接覆盖更新不重传）。

---

## 3. CLI 速查

### resync_notion.py

```bash
# dry-run（不写 Notion，只读 SQLite 打 plan）
python scripts/resync_notion.py --internal-id 53675 --dry-run

# 单封实跑（已存在则跳过）
python scripts/resync_notion.py --internal-id 53675

# 单封强制替换（archive 老页 → 新建）
python scripts/resync_notion.py --internal-id 53675 --replace-existing

# 区间
python scripts/resync_notion.py --range 53000-53100

# 多 internal_id
python scripts/resync_notion.py --internal-ids 53674,53675,53677
```

**注意**：默认 `skip_parent_lookup=True` —— 不会重建 Notion 上既有的线程关系（diff 验证用途）。

### backfill_derivatives.py

```bash
# dry-run 看候选数
python scripts/backfill_derivatives.py --dry-run

# 单封补
python scripts/backfill_derivatives.py --internal-id 53677

# 全量补
python scripts/backfill_derivatives.py
```

**幂等性**：候选条件 `NOT EXISTS (derived child)`，重复跑不会重复补。

**与已上传 Notion 页面的关系**：单纯补 SQLite，**不会**让 Notion 上的旧页面自动出现 derived 附件。要更新 Notion 需要再跑 `resync_notion.py --replace-existing`。

---

## 4. 生产灰度切换验证（2026-05-16）

3 封最近邮件（53674 / 53675 / 53677）用 `resync_notion.py --replace-existing` 走 SQLite SSoT 路径重建：

| internal_id | 主题 | 老 page_id（已 archive） | 新 page_id（v4 from_sqlite） |
|---|---|---|---|
| 53674 | RE: Action Required – POC Support... | `36215375-830d-81e5-bc6c-cca710503509` | `36215375-830d-815a-8a61-c363c7ce93fa` |
| 53675 | RE: Design Hub与Omada Store联动... | `36215375-830d-8145-ac75-f1d2ebed3029` | `36215375-830d-810c-8114-e3dc9e8bdc2c` |
| 53677 | Hi Email dual-write test | `36215375-830d-813c-be9f-e283832fa61b` | `36215375-830d-81ba-8743-e41b5f233520` |

**人眼对比结果（用户反馈）**：
- ✅ 内联图片显示正常（cid 还原链路 OK）
- ✅ 邮件正文 / properties 格式无差异
- ⚠ Parent / Sub-item 缺失 —— 预期（`resync_notion.py` 默认 skip）；生产 sync 路径会正常建
- ⚠ LLM AI 字段缺失 —— 预期（LLM hook 挂在 `new_watcher._sync_single_email_v3`，CLI resync 不经 new_watcher）；生产 sync 路径会正常触发
- ⚠ 53677 缺 CSV 衍生附件 —— 非 Phase 4 路径锅，是 `backfill_email_body.py` 那封邮件上 Office 转换 silent fail；已用 `backfill_derivatives.py` 补齐并 re-resync

**最终 53677 新页（带 CSV）**: `36215375-830d-81ba-8743-e41b5f233520`（PNG + xlsx + 衍生 csv 三附件齐全）

---

## 5. 影响范围 / 回退

### 影响范围
- **新邮件生产 sync**：默认 `NOTION_READ_FROM_SQLITE=false`，无影响
- **Notion 上的 page 数据**：不动（除非用 `resync_notion.py` 手动重传）
- **历史邮件 backfill**：`backfill_email_body.py` 加日志加固，告警出 silent fail 但行为不变

### 切灰度后影响（NOTION_READ_FROM_SQLITE=true）
- new_watcher → `create_email_page_v2(email)` → wrapper 检测到 SQLite 有 body → delegate 到 `create_email_page_from_sqlite` → 产物与老路径等价（cid 还原确保内联图正确）
- LLM hook + 反向同步 + thread relations 仍由 new_watcher 调度，路径无变
- `email_attachment.notion_file_id` 会被回写，为后续运维工具打底

### 回退
- 单封：`pages.update(page_id=..., archived=False)` 从 Trash 恢复老页
- 全局：`.env` 设 `NOTION_READ_FROM_SQLITE=false` + `pm2 restart mail-sync` → 回到 v2 老路径
- 完全回滚：`git revert <Phase 4 commit>` —— 不动 schema / SQLite 数据，rollback 干净

---

## 6. 切灰度操作步骤（待用户执行）

**前置条件**：
- backfill_email_body.py 跑完（当前 1238/8493 ~15%；估约 6-8 小时）
- `python scripts/backfill_derivatives.py` 兜底跑一次（候选数应该很少）
- 抽样 3-5 封历史邮件做 diff 验证（已做 3 封）

**执行**：
```bash
# 1. 编辑 .env
echo "NOTION_READ_FROM_SQLITE=true" >> .env

# 2. 重启 mail-sync 加载新配置
pm2 restart mail-sync && sleep 3 && pm2 status

# 3. 观察日志确认走新路径
pm2 logs mail-sync --lines 50 --nostream | grep "routing to from-sqlite\|created from SQLite"
```

**预期日志特征**：
- `[v4] routing to from-sqlite path: internal_id=X` —— 路由切换到新路径
- `Email page created from SQLite (v4): <subject> (page_id=...)` —— 新页面创建
- `Wrote back N notion_file_id entries for internal_id=X` —— 回写完成

---

## 7. 后续待办

1. **Phase 5**（未来）：Web / Electron 前端，对接 SQLite SSoT + FTS5 search
2. **T-01**：Notion sync 迁 Markdown API —— Phase 4 拿到 `body_markdown` 在手，`PATCH /pages/:id/markdown` 比 children blocks 更简洁。参考样板 `src/project_progress/notion_sync.py`
3. **T-06**：附件 orphan cleanup CLI —— 现在 `email_attachment.notion_file_id` 已有数据，可以扫"上传到 Notion 但 SQLite 没记录"的悬挂附件
4. **架构归一**：Notion 真正成为"镜像"——所有出口（LLM / fetch_mail_content / search / Notion uploader）全部走 SQLite

---

## 8. 关键文件入口（速查）

### Phase 4 新代码
- `src/notion/sync.py:23-50` — `NotionSync.__init__` + `_ensure_sqlite_resources`（lazy DI）
- `src/notion/sync.py:783-950` — 5 个 SQLite 辅助 + cid 还原
- `src/notion/sync.py:952-1003` — `create_email_page_v2` wrapper 灰度路由
- `src/notion/sync.py:1145-1265` — `create_email_page_from_sqlite` 主入口
- `scripts/resync_notion.py` — CLI 全文
- `scripts/backfill_derivatives.py` — 补救工具全文
- `tests/notion/test_create_from_sqlite.py` — 21 个测试

### 不动的（前阶段已就位）
- `src/repository/email_repository.py` 全部
- `src/repository/storage_payload_builder.py` 全部
- `src/mail/new_watcher.py` — dual-write 入口不变（Phase 1）

---

> **新 session 接手指令**：
>
> Phase 4 主体已 ship；灰度开关 `NOTION_READ_FROM_SQLITE=false`。
>
> 进入 Phase 5 / T-01 / T-06 前，建议先完成生产灰度切换：
> 1. 等 `backfill_email_body.py --since-date 2026-03-01` 跑完
> 2. 跑 `python scripts/backfill_derivatives.py` 兜底补漏 derived
> 3. `.env` 加 `NOTION_READ_FROM_SQLITE=true` + `pm2 restart mail-sync`
> 4. 观察首批新邮件经新路径的日志特征 + Notion 上人眼对比
