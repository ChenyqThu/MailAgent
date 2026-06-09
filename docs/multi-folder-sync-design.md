# 多文件夹同步 — 技术设计文档（总设 + 详设）

> 实现 [`multi-folder-sync-prd.md`](./multi-folder-sync-prd.md) 所定义的「自定义文件夹完整 pipeline 同步」。
>
> **状态**：✅ **已实现**（P1-P6 全部落地，2026-06-09；实现语义见 [`architecture-internals.md`「多文件夹同步」](./claude/architecture-internals.md)，进度看板见 [matrix](./multi-folder-sync-matrix.md)）
> **决策基线**：完整 pipeline · 完整写操作 · 白名单手动勾选 · davmail-only · 文件夹管理 + 嵌套层级（davmail 支持前提，D5/D6）· 统一接管废弃旧 folder_sync 展示链路（D7，附录 B）
> **看板/设计/mockup**：[能力矩阵](./multi-folder-sync-matrix.md) · [设计 handoff](./multi-folder-sync-design-handoff.md) · [mockup](./mockups/multi-folder-sync/index.html)
> **关联**：[`architecture-internals.md`](./claude/architecture-internals.md)（v3/Sprint15-16 主链路）、[`service-layer-architecture.md`](./claude/service-layer-architecture.md)（写面）、[`folder-ui-prd.md`](./folder-ui-prd.md)（folder_sync 展示模块）、[`multi-folder-sync-handoff.md`](./multi-folder-sync-handoff.md)（实现作战地图）
> **最后更新**：2026-06-08
>
> **文档分层**（本文一份承载总设 + 详设两个职责）：**总体设计 = §1-3**（概述目标 / 现状瓶颈 / 架构改动总览，供架构对齐 + codex review 看全局）；**详细设计 = §4-10**（后端/前端详细设计 / 数据流 / 分阶段 / 验收 / 风险 / 文件清单，供实现）。

---

## 1. 概述与设计目标

让 davmail 把**用户勾选的任意自定义文件夹**接入现有 email_metadata 主链路，使其邮件获得与收件箱完全一致的全套能力。

**设计原则**：
1. **最大化复用主链路**——自定义文件夹邮件一旦落入 `email_metadata`（带正确 `mailbox` 字段），下游 Notion / LLM / 通知 / 线程 / FTS / 列表 **几乎零改动**即可工作（已验证这些环节按 `mailbox` 字段透传，无硬编码 INBOX）。
2. **改造集中在「取数入口」**——核心瓶颈是 davmail `get_new_emails()` 写死 INBOX+Sent 与单一全局游标；改造聚焦于此。
3. **不耦合 folder_sync 展示模块**——现有 `folder_email` 表是「存档/草稿箱纯展示」链路，与本功能（主链路）正交，不混用。
4. **davmail-only**——AppleScript 路径门控关闭。

---

## 2. 现状与实测结论

### 2.1 实测（已验证 davmail 能力，2026-06-08）

| 验证项 | 方法 | 结果 |
|---|---|---|
| 文件夹枚举 | `imap.list("", "*")` | 返回 18 个文件夹，含全部自定义文件夹 |
| 中文文件夹名 | modified-UTF7 解码 | `DMS&VvpO9lPRXgM-` → 「DMS固件发布」✓ |
| 取数 | `SELECT` + `UID SEARCH ALL` | Jira 3458 / Notion 381 / DMS 728 封均取到 ✓ |
| 增量游标 | `STATUS (UIDNEXT UIDVALIDITY)` | 每文件夹独立 UIDVALIDITY/UIDNEXT ✓ |

### 2.2 当前同步链路（主链路）

```
new_watcher._poll_cycle (src/mail/new_watcher.py:382)
  last_max_row_id = sync_store.get_last_max_row_id()      # 单一全局游标 ⚠️
  radar.check_for_changes(last_max_row_id)
  new_emails = radar.get_new_emails(last_max_row_id)       # davmail: DavMailBackend.get_new_emails
      → INBOX: UID > since_row_id                          # 写死 ⚠️
      → Sent:  仅当 _sync_sent；marker 从 SQLite 派生        # 写死 ⚠️
  for e in new_emails: sync_store.save_email(e)            # mailbox 字段透传 ✓
  sync_store.set_last_max_row_id(current_max)              # 单一全局游标 ⚠️
  → 下游: Notion / LLM / 通知 / 线程 (按 mailbox 透传, 无 INBOX 硬编码 ✓)
```

### 2.3 核心瓶颈（必须改造）

| 瓶颈 | 位置 | 问题 |
|---|---|---|
| **取数写死 INBOX+Sent** | [`davmail_backend.py:1148-1173`](../src/mail/backend/davmail_backend.py:1148) `get_new_emails()` | 不遍历白名单 |
| **单一全局游标** | [`sync_store.py:1348-1355`](../src/mail/sync_store.py:1348) `get/set_last_max_row_id` | 多文件夹无独立 marker |
| **无文件夹发现 API** | — | `imap.list()` 底层有，未封装暴露 |
| **配置无白名单** | [`config.py:133`](../src/config.py:133) `sync_mailboxes` | 只 honor 收件箱/发件箱 |
| **归档/移动写死 INBOX→Archive** | [`mail_write.py:659`](../src/services/mail_write.py:659) `archive_inbox_message` | 不支持任意 src/dst |

### 2.4 已天然就绪（无需改造，复用）

| 已就绪 | 证据 |
|---|---|
| `email_metadata.mailbox` TEXT 无约束 + 索引 | [`sync_store.py:322,360,700`](../src/mail/sync_store.py:322) |
| davmail internal_id 分配与 folder 无关 | [`sync_store.py:2029`](../src/mail/sync_store.py:2029) `allocate_davmail_internal_id`（起点 1e9 自增） |
| 取数函数已按 folder 参数化 | [`davmail_backend.py:1178`](../src/mail/backend/davmail_backend.py:1178) `_fetch_new_in_folder(imap, imap_folder, label, criteria, ...)` |
| Notion Mailbox Select 自动建 option | [`pages.py:456`](../src/notion/pages.py:456) |
| 列表查询已支持 mailbox 过滤 | `listEnriched` WHERE mailbox=?（[`sync_store.py:697`](../src/mail/sync_store.py:697)） |
| 回复/转发 compose 与 folder 无关 | 按 message_id 取原文 + SMTP |

---

## 3. 架构改动总览

| 层 | 模块 | 改动 | 类型 |
|---|---|---|---|
| **后端** | `imap_client.py` / `davmail_backend.py` | 新增 `list_folders()` 文件夹发现 + modified-UTF7 解码 | 新增 |
| | `config.py` + `.env.example` | 新增 `SYNC_FOLDERS` 白名单 + 窗口配置 | 新增 |
| | `sync_store.py` | per-folder 游标存储（state 扩展或小表）+ DB v22 迁移 | 改 schema |
| | `davmail_backend.py` `get_new_emails()` | 遍历白名单文件夹（含 per-folder marker + uidvalidity 检测） | 重构 |
| | `new_watcher.py` `_poll_cycle` | 多文件夹变化检测 + 游标管理 | 改 |
| | `services/mail_write.py` | 归档/移动泛化 src/dst folder | 改 |
| | `folder_sync/imap_folder_reader.py` | `move_message` 扩展任意 src/dst | 改 |
| | CLI `cli/commands/folder.py` | `folder discover` / `folder enable/disable` 命令 | 新增 |
| | serve-api `api/routers/folder.py` | `GET /api/folder/discover` + 白名单读写端点 | 新增 |
| **前端** | `settings/tabs/SyncTab.tsx` | `<FolderPicker>` 动态文件夹选择器 | 新增组件 |
| | `onboarding/steps.tsx` | 文件夹勾选步骤 | 新增步骤 |
| | `layout/Sidebar.tsx` | MAILBOXES 段动态渲染白名单文件夹 | 改 |
| | `hooks/useMailApi` + IPC | folder discover / 白名单读写 API | 新增 |

### 3.1 复杂度与稳定性评估

- **工作量**：中等，8-12 天（P1-P5）；MVP（P1+P2 纯后端）3-4 天可 CLI/sqlite 独立验收。
- **复杂度**：中等偏高，但**有现成范例**——发件箱(Sent)已是「独立 UID 空间 + 派生游标 + 独立 try 隔离」模式，多文件夹 = 把它泛化到 N 个；下游 Notion/AI/通知/线程/搜索几乎零改动。真正硬点仅 per-folder UIDVALIDITY 处理（message_id 去重兜底）。
- **稳定性影响：低**。隔离是首要设计目标：① `SYNC_FOLDERS` 默认空 = 新代码零激活 = 与现状逐字节一致；② 收件箱主路径不碰（新逻辑在 INBOX 段后**追加**）；③ 每文件夹独立 try；④ 不耦合 folder_sync 展示模块。回滚 = 清空 `SYNC_FOLDERS`。

---

## 4. 后端详细设计

### 4.1 文件夹发现 `list_folders()`

新增到 `DavMailBackend`（或 `imap_client.py` 模块级），供 CLI/serve-api 调用：

```python
def list_folders(self) -> list[FolderInfo]:
    """IMAP LIST 全部文件夹 → [{imap_name, display_name, special_use, message_count}]。"""
    out = []
    with imap_session(self.cfg, timeout=30) as imap:
        typ, data = imap.list("", "*")
        for line in data or []:
            flags, delim, imap_name = _parse_list_line(line)   # 解析 (\Flags) "/" "name"
            display = decode_imap_utf7(imap_name)               # modified-UTF7 → unicode
            special = _special_use_from_flags(flags)            # \Inbox/\Sent/\Drafts/\Junk/\Trash/\Archive
            count = _status_messages(imap, imap_name)           # STATUS 取邮件数（可懒加载）
            out.append(FolderInfo(imap_name, display, special, count))
    return out
```

**`decode_imap_utf7`**：已在实测脚本验证（`&` 引入 base64，`,`→`/`，`&-`=字面 `&`）。RFC 3501 modified-UTF7。

**FolderInfo**（新 dataclass / Pydantic）：`imap_name`（ASCII 原始名，白名单存储用）、`display_name`（解码后展示）、`special_use`（区分系统文件夹）、`message_count`、`is_syncable`（排除 Trash/Junk 等可选）。

**性能**：`STATUS` 逐文件夹一次 RTT；18 个文件夹 < 1s。可优化：列表先返回不含 count，count 异步/懒加载。

### 4.2 配置 `SYNC_FOLDERS`

```python
# src/config.py（参考 sync_mailboxes:133）
sync_folders: str = Field(
    default="",
    env="SYNC_FOLDERS",
    description="额外同步的自定义文件夹白名单。存 IMAP 原始名(modified-UTF7, ASCII)，逗号分隔。"
               "空=不同步任何自定义文件夹(默认)。收件箱/发件箱由 SYNC_MAILBOXES 管，不在此列。",
)
folder_sync_past_days: int = Field(default=90, env="FOLDER_SYNC_PAST_DAYS", ...)      # 首次窗口
folder_sync_max_messages: int = Field(default=2000, env="FOLDER_SYNC_MAX_MESSAGES", ...)  # 单文件夹上限
```

**关键决策**：白名单存 **IMAP 原始名（modified-UTF7，纯 ASCII）**，不存中文 display name——避免 display name 不稳定。前端展示时解码。

> **🔴 已实现修正（P1 codex review）**：白名单用 **JSON 数组**字符串存（`["Notion","&W,mL3VOGU,KLsF9V-"]`），**不能用逗号分隔** —— modified-UTF7 的 base64 段**本身用逗号**代替 `/`（如 对话历史记录 = `&W,mL3VOGU,KLsF9V-` 含两个逗号），逗号分隔会拆坏中文名。`_parse_custom_folders` JSON 优先 + CSV 回退（兼容旧简单 ASCII 名）。CLI `folder enable/disable` 写 JSON。

### 4.3 per-folder 游标存储（核心）

**问题**：现状单一 `last_max_row_id`（INBOX uidnext marker）。多文件夹每个有独立 UID 空间 + UIDVALIDITY。

**方案对比**：

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A. 从 email_metadata 派生**（推荐主体） | per-folder marker = `MAX(imap_uid) WHERE mailbox=? AND backend_origin='davmail'`；首次回退 `SINCE <past_days>` | 零新表，复用 Sent 成熟模式（`get_new_emails` 注释已述）；**但** UIDVALIDITY 变化检测需补 |
| **B. 轻量 per-folder state 小表** | 新表 `folder_cursor(imap_name PK, mailbox_label, last_uid, uidvalidity, last_sync_at)` | 干净、可存 uidvalidity；需 DB 迁移 |

**推荐**：**A + 轻量 uidvalidity 记录**。marker 主体从 email_metadata 派生（与 Sent 一致，避免 marker 与实际数据不一致的 bug），uidvalidity 单独记一处（可塞进现有 `state` KV 表，key=`folder_uidvalidity:<imap_name>`，复用 `get_state/set_state` [`sync_store.py:1348`](../src/mail/sync_store.py:1348) 同款）。uidvalidity 变化时该文件夹全量重拉（清 marker）。

> 不复用 `folder_sync_state` 表——那是 folder_email 展示模块的（语义 archive/drafts），混用会耦合两条正交链路。

### 4.4 `get_new_emails()` 多文件夹遍历

把 [`davmail_backend.py:1146-1176`](../src/mail/backend/davmail_backend.py:1146) 的「INBOX + Sent 两段」泛化为「遍历同步目标列表」：

```python
def get_new_emails(self, since_row_id: int) -> list[dict]:
    out = []
    with imap_session(self.cfg, timeout=60) as imap:
        # INBOX（主路径，保持现状）
        out.extend(self._fetch_new_in_folder(imap, "INBOX", "收件箱",
                   ("UID", f"{since_row_id+1}:*"), track_inbox_uidvalidity=True))
        # 发件箱（保持现状）
        if self._sync_sent and self.sent_folder:
            out.extend(self._fetch_sent(imap))
        # 【新】自定义文件夹白名单
        for imap_name in self._custom_folders:          # 来自 cfg.sync_folders
            try:
                label = decode_imap_utf7(imap_name)
                marker, uv = self._folder_marker(imap_name)   # 派生 marker + state uidvalidity
                criteria = self._folder_search_criteria(imap_name, marker, uv)  # UID>marker 或 SINCE 回填
                out.extend(self._fetch_new_in_folder(imap, imap_name, label, criteria,
                           track_inbox_uidvalidity=False, max_messages=cfg.folder_sync_max_messages))
                self._persist_folder_uidvalidity(imap_name, uv_current)
            except Exception as e:
                logger.error(f"[davmail] custom folder {imap_name!r} sync failed (others unaffected): {e}")
    return out
```

- **每文件夹独立 try**：一个失败不影响其它（沿用 Sent 的隔离原则 [`davmail_backend.py:1158`](../src/mail/backend/davmail_backend.py:1158)）。
- **`_fetch_new_in_folder` 已参数化**——复用，只需补 `max_messages` 截断 + UIDVALIDITY 重拉分支。
- **mailbox 字段** = `label`（中文显示名），写入 email_metadata → 下游全链路透传。
- **首次窗口**：`SINCE <today - past_days>` + `max_messages` 末尾截断，防 Jira 3458 封灌爆。

### 4.5 完整 pipeline 接入（下游几乎零改动）

一旦邮件带正确 `mailbox` 落入 email_metadata，下游自动工作：

| 环节 | 是否改动 | 说明 |
|---|---|---|
| Notion 同步 | **零改动** | `Mailbox` Select 自动建 option（[`pages.py:456`](../src/notion/pages.py:456)），自定义文件夹名直接写 |
| LLM 分类 | **零改动** | 按 internal_id 分类，与 mailbox 无关 |
| 线程 | **零改动** | 按 thread_id/references 关联 |
| FTS5 搜索 | **零改动** | save_email 自动入 FTS |
| 列表/详情 | **零改动** | listEnriched WHERE mailbox=? 现成 |
| **通知** | **需 gate** | 见下 |

**通知降噪**（PRD §6.4）：自定义文件夹（尤其 Jira/Bugzilla 自动化通知）默认**不触发飞书通知**。实现：通知判定处加 `mailbox in custom_folders → 默认 skip，除非该 folder 显式开启通知`。需要 per-folder 通知开关（首期可全局：自定义文件夹一律不通知）。

### 4.6 写操作泛化

| 操作 | 现状 | 改动 |
|---|---|---|
| 标旗 / 标已读 | outbox + FanoutWorker，按 internal_id/message_id | **验证**派发能按邮件所属 folder 定位 IMAP（reverse 派发需 SELECT 正确 folder）；大概率小改 |
| **归档** | [`mail_write.py:659`](../src/services/mail_write.py:659) `archive_inbox_message` 写死 INBOX→Archive | 泛化：`move(src_folder, internal_id, dst=Archive)` |
| **移动到其它文件夹** | 无 | 新增 `move_to_folder(internal_id, dst_imap_name)`，底层复用 [`imap_folder_reader.py:361`](../src/folder_sync/imap_folder_reader.py:361) `move_message`（现 src 限 archive/drafts，扩展任意 src） |
| 回复 / 转发 | compose + SMTP，folder 无关 | **零改动** |

**move_message 扩展**：现签名 `move_message(src_folder, uid, dst_imap)` 但 `resolve_imap_folder` 只认 archive/drafts。需让它接受任意 IMAP folder 名（自定义文件夹的 imap_name 直传）。

### 4.7 DB schema 迁移

- **DB_VERSION 21 → 22**（[`sync_store.py:227`](../src/mail/sync_store.py:227)）。
- 若选方案 B 小表则建 `folder_cursor`；若选方案 A 则**无新表**（uidvalidity 走现有 state KV 表，无需 schema 变更，仅 bump version 记录语义）。
- idempotent migration（用 `/db-migration` skill）。
- **🔴 同步前端 `EXPECTED_DB_VERSION`**（`frontend/src/electron/main/backend_lifecycle.ts`）——CLAUDE.md 铁律，漏改打包 app 启动门控卡 120s。

---

### 4.8 文件夹管理（创建/重命名/删除，davmail 支持前提）

> 🔴 P1 前置实测：用一个测试文件夹验证 davmail 的 `CREATE`/`RENAME`/`DELETE` 能成功映射到 EWS（系统文件夹通常不可删/改）。

- **新增 backend/services 方法**：`create_folder(imap_name)` / `rename_folder(old, new)` / `delete_folder(imap_name)`，底层 imaplib `imap.create/rename/delete`。
- **系统文件夹保护**：维护保护集（INBOX/Sent/Drafts/Junk/Trash + special-use 标志的），管理前 gate，拒绝并提示。
- **走 outbox SSoT**：管理操作作为 intent 入 outbox + FanoutWorker 派发（与 flag/archive 一致），失败回滚本地树到服务器真实状态。
- **重命名一致性**：RENAME 成功 → 批量 UPDATE email_metadata 该 folder 的 `mailbox` 字段 + Notion 镜像。
- **删除一致性**：DELETE 成功 → 清理该 folder 的本地 email_metadata 行（+ 可选 Notion 页）+ 从白名单移除。
- CLI/serve-api：`folder create/rename/delete` + `POST/PATCH/DELETE /api/folder/{name}`（写鉴权）。

### 4.9 嵌套层级树（davmail 支持前提）

> 🔴 P1 前置实测：建一个 `测试/子` 嵌套文件夹，确认 davmail LIST 返回 `测试/子`（delimiter `/`）+ 中文层级解码正常。

- **发现**：`list_folders()` 解析 LIST 每行的 hierarchy delimiter（实测 `/`）+ `\HasChildren`/`\HasNoChildren` 标志，把平铺的 `parent/child` 列表**还原成树**（`FolderNode{imap_name, display, children[], has_children}`）。
- **白名单存储**：仍存 IMAP 原始名（含层级路径如 `测试/子`，ASCII modified-UTF7）。勾父文件夹「含子」时展开成子路径集。
- **同步**：每个被勾选 folder（无论层级）独立走 §4.4 遍历 + per-folder 游标；层级只影响**呈现与勾选语义**，不影响取数。
- **降级**：解析不出层级（当前都顶层）→ 退化平铺，零影响。

---

## 5. 前端详细设计

### 5.1 folder 发现 API / IPC

- **serve-api**：`GET /api/folder/discover` → `list_folders()` 结果（imap_name / display / count / special_use / is_synced）。`GET/PUT /api/folder/whitelist` 读写 `SYNC_FOLDERS`。
- **CLI**：`mailagent folder discover -o json` / `folder enable <imap_name>` / `folder disable <imap_name>`（agent-friendly，可单测）。
- **IPC + useMailApi**：`mailApi.folder.discover()` / `mailApi.folder.getWhitelist()` / `setWhitelist()`，走现有 daemon 转发（D1 架构，Main 进程注入本地 token）。

### 5.2 SyncTab 文件夹选择器 `<FolderPicker>`

现有 [`SyncTab.tsx:84-133`](../frontend/src/shared/components/settings/tabs/SyncTab.tsx:84) 「文件夹同步（存档/草稿箱）」区是纯 `EnvField`。新增动态组件（EnvField 不支持动态拉取的列表）：

```
<Section title="自定义文件夹同步">
  <FolderPicker>                          // 新组件
    [刷新] 按钮 → mailApi.folder.discover()
    列表: [☑] DMS固件发布  (728)  已同步 2分钟前
          [☐] Jira         (3458) ⚠ 较大
          [☑] Notion       (381)
    收件箱/发件箱: 锁定行(已同步, 不可取消)
    [保存] → setWhitelist(checkedImapNames)
  </FolderPicker>
  <EnvField envKey="FOLDER_SYNC_PAST_DAYS" .../>
  <EnvField envKey="FOLDER_SYNC_MAX_MESSAGES" .../>
</Section>
```

- davmail 门控：非 davmail 后端禁用 + 提示。
- 空态：未发现自定义文件夹时引导文案。

### 5.3 Onboarding 勾选步骤

- [`onboarding/steps.tsx`](../frontend/src/electron/renderer/onboarding/steps.tsx) 在邮箱多选步之后插入「选择文件夹」步（复用现有第 4 步多选 UI 范式）。
- 仅 davmail 显示；可跳过；系统文件夹锁定；大文件夹提示。
- 落盘与其它 onboarding 配置同路径（`handlers/onboarding.ts`）。

### 5.4 Sidebar 动态渲染 + folder 过滤

- [`Sidebar.tsx:185-226`](../frontend/src/shared/components/layout/Sidebar.tsx:185) MAILBOXES 段：在存档/草稿箱后**动态追加**白名单文件夹行。
- 数据源：`mailApi.folder.getWhitelist()` + 各 folder 计数（扩展 `listMailboxes()` 返回自定义文件夹计数，或复用 folder count query）。
- 行渲染：复用 `NavRow` + `CountRight`；统一「文件夹」图标。
- 点击：`setActiveMailbox(displayName)` + 列表 query 按 mailbox 过滤（listEnriched 现成）。
- **§2.11 铁律**：挂在 MAILBOXES 段内，**不新增 section header**。多文件夹时加「展开更多」折叠。

---

### 5.5 文件夹树组件（替代纯列表）

- `<FolderPicker>` 内部用**树形**渲染（缩进 + 展开/收起 chevron），数据源 = `list_folders()` 树结构。
- 复用现有 NavRow/行样式；层级缩进用左 padding 递增。
- 勾父节点弹「仅本级 / 含子文件夹」。
- Sidebar 自定义文件夹区同样树形（缩进 + 展开/收起），严守三段 header 铁律（挂 MAILBOXES 段内）。

### 5.6 文件夹管理 UI

- 配置页树每行 hover/右键出操作菜单（新建子文件夹 / 重命名 / 删除）。
- 系统文件夹：操作灰态禁用 + tooltip「系统文件夹不可改」。
- 删除/重命名：二次确认弹窗（说明影响真实 Exchange + 本地副本）。
- 新建：inline 输入或小弹窗（选父 + 输名）。
- 操作走 `mailApi.folder.create/rename/delete()` → daemon 转发 serve-api（D1 架构）。

---

## 6. 数据流（自定义文件夹新邮件）

```
davmail IMAP (folder=Jira)
  → get_new_emails: 遍历白名单 → _fetch_new_in_folder(imap, "Jira", "Jira", UID>marker)
  → allocate_davmail_internal_id (≥1e9) + mailbox="Jira" + backend_origin="davmail"
  → save_email → email_metadata (mailbox="Jira") + FTS
  → [下游零改动] LLM 分类 → Notion 同步 (Mailbox="Jira") → 线程关联
  → [通知 gate] mailbox 是自定义文件夹 → 默认不通知
  → 前端 Sidebar "Jira" 行计数 +1；点击列表 WHERE mailbox="Jira"
```

写操作（归档 Jira 某邮件到 Archive）：
```
前端 archive(internal_id) → mail_write.move(src="Jira", dst="Archive")
  → outbox intent → FanoutWorker → IMAP MOVE (SELECT Jira → COPY Archive → STORE \Deleted)
  → email_metadata.mailbox 更新 + Notion 镜像更新
```

---

## 7. 分期实施

| 阶段 | 范围 | 验证方式 | 工作量（粗估） |
|---|---|---|---|
| **P1 后端取数核心** | `list_folders()` + `SYNC_FOLDERS` 配置 + per-folder marker + `get_new_emails` 多文件夹遍历 + DB v22 | CLI `folder discover` + 配 SYNC_FOLDERS 跑 main.py，sqlite 查 email_metadata 出现自定义文件夹邮件 | 2-3 天 |
| **P2 下游 pipeline 验证 + 通知 gate** | 确认 Notion/LLM/FTS/线程 对自定义文件夹工作 + 通知降噪 | Notion 页面 Mailbox 字段对 + 搜索命中 + 不刷飞书 | 1 天 |
| **P3 前端配置 + Sidebar** | `<FolderPicker>` + serve-api/IPC + Sidebar 动态渲染 + 列表过滤 | 设置页勾选 → Sidebar 出现 → 点击过滤 | 2-3 天 |
| **P4 onboarding + 写操作泛化** | onboarding 步骤 + 归档/移动 src/dst 泛化 + move_message 扩展 | 新用户 onboarding 勾选；自定义文件夹内归档/移动/回复 | 2-3 天 |
| **P5 边界打磨** | 取消同步数据清理 + UIDVALIDITY 重拉 + 大文件夹分批 | 取消勾选行为；改 Outlook 文件夹结构重拉 | 1-2 天 |
| **P6 folder_sync 展示链路清理**（独立 cleanup，功能稳定后） | 删 FolderSyncWorker + folder_email/_fts/folder_sync_state 三表 + 老 folder router/CLI 展示端点 + Sidebar 老数据源；**FolderImapReader 迁出 folder_sync 保留**（归档/草稿/写操作泛化依赖） | 归档/草稿/发送回归全过 + 残留检测无 folder_email 引用 | 1-2 天 |

**MVP = P1 + P2**（后端可单独验收，纯 CLI/sqlite 验证，不依赖前端）。

> **文件夹管理（§4.8）+ 嵌套层级（§4.9）的阶段归属**：层级**发现**在 P1（list_folders 解析树，含 davmail 嵌套实测前置）、层级**树 UI** 在 P3、文件夹**管理 CRUD** 在 P4（含 davmail CREATE/RENAME/DELETE 实测前置）。davmail 不支持某子项时优雅降级（平铺 / 隐藏管理操作）。

---

## 8. 验收逻辑

### 8.1 后端（P1+P2）
```bash
# 1. 文件夹发现
mailagent folder discover -o json | jq '.data[] | {name: .display_name, count: .message_count}'
# 期望: 列出 18 个文件夹含中文名 + 邮件数

# 2. 配置白名单 + 同步
echo 'SYNC_FOLDERS=Notion,Jira' >> .env   # 用 imap 原始名
python3 main.py   # 或 pm2 restart
sqlite3 data/sync_store.db "SELECT mailbox, COUNT(*) FROM email_metadata WHERE backend_origin='davmail' GROUP BY mailbox"
# 期望: 出现 mailbox='Notion' / 'Jira' 的行

# 3. per-folder 增量（不重复拉）
# 二次 poll 后 count 不应翻倍；marker 正确推进

# 4. 下游 pipeline
#   - Notion: 对应页面 Mailbox 字段 = 文件夹名
#   - 搜索: mailagent email search "<关键词>" 能命中自定义文件夹邮件
#   - 通知: 自定义文件夹新邮件不刷飞书（gate 生效）
```

### 8.2 单元/集成测试
- `tests/mail/test_imap_utf7.py`：modified-UTF7 解码（喂 `DMS&VvpO9lPRXgM-` → 「DMS固件发布」）。
- `tests/mail/test_list_folders.py`：mock IMAP LIST 响应 → FolderInfo 解析。
- `tests/mail/test_get_new_emails_multifolder.py`：mock 多文件夹 → marker 推进 + max_messages 截断 + 单文件夹失败隔离。
- `tests/cli/test_folder_discover.py`：CLI 契约。
- `tests/api/test_folder_discover.py`：serve-api 端点 + 鉴权。
- per-folder marker：UIDVALIDITY 变化 → 全量重拉分支。

### 8.3 前端（P3+P4）
- `<FolderPicker>` 组件测试（拉取/勾选/保存/门控/空态）。
- Sidebar 渲染自定义文件夹 + 点击过滤。
- onboarding 步骤集成测试。
- typecheck + build:web 零 Electron 回归。

### 8.4 真机 e2e
- feature 分支 build `.app`（**🔴 必先 `bash frontend/scripts/build-python-venv.sh` 重 provision**——分支改了 Python 后端）。
- 装机：配置页勾选文件夹 → Sidebar 出现 → 点击查看 → AI 分类/Notion 同步/回复/归档全链路。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 大文件夹（Jira 3458 封）首次同步阻塞主收件箱 | 窗口（past_days）+ 上限（max_messages）+ 每文件夹独立 try + 末尾截断；后续考虑后台分批 |
| 多文件夹拖慢 poll cycle（每文件夹 SELECT+SEARCH RTT） | 先 STATUS（轻）判变化，变了才 SELECT；poll 间隔可调 |
| UIDVALIDITY 变化导致 marker 失效重复拉 | per-folder uidvalidity 记录 + 变化时全量重拉；save_email 的 message_id merge 去重兜底 |
| Notion Mailbox Select option 膨胀 | 文件夹数有限（18）；Notion select option 上限足够 |
| 通知骚扰（自动化通知文件夹） | 自定义文件夹默认不通知（§4.5） |
| 取消同步后残留数据 | 默认保留 + 提供清理选项（P5 定） |
| **回滚** | `SYNC_FOLDERS=` 置空 → 退回只同步收件箱/发件箱；新增代码全在白名单为空时不执行（零影响） |

**回滚保证**：所有改造在 `SYNC_FOLDERS` 为空（默认）时**完全不激活**——`get_new_emails` 自定义文件夹循环跳过，行为与现状逐字节一致。这是最强的灰度保护。

---

## 10. 关键文件清单（改动锚点）

| 文件 | 改动 |
|---|---|
| `src/mail/backend/imap_client.py` / `davmail_backend.py` | `list_folders()` + `decode_imap_utf7()` + `get_new_emails` 多文件夹 + per-folder marker helper |
| `src/mail/sync_store.py` | per-folder uidvalidity（state KV 复用）+ DB v22 bump |
| `src/config.py` + `.env.example` | `SYNC_FOLDERS` / `FOLDER_SYNC_PAST_DAYS` / `FOLDER_SYNC_MAX_MESSAGES` |
| `src/mail/new_watcher.py` | `_poll_cycle` 多文件夹变化检测 |
| `src/services/mail_write.py` + `src/folder_sync/imap_folder_reader.py` | 归档/移动 src/dst 泛化 |
| `src/cli/commands/folder.py` | `folder discover/enable/disable` |
| `src/api/routers/folder.py` + `schemas/folder.py` | discover + whitelist 端点 |
| `frontend/.../settings/tabs/SyncTab.tsx` + 新 `FolderPicker.tsx` | 文件夹选择器 |
| `frontend/.../onboarding/steps.tsx` | 文件夹勾选步骤 |
| `frontend/.../layout/Sidebar.tsx` | MAILBOXES 段动态渲染 |
| `frontend/src/electron/main/backend_lifecycle.ts` | `EXPECTED_DB_VERSION` 同步 bump |

---

## 附录 A：通知策略张力（待产品定调）

PRD 决策「完整 pipeline」与「通知骚扰」存在张力。本设计采取：**自定义文件夹默认 AI 分类 + Notion + 搜索 + 列表（完整），但通知默认关**，per-folder 可选开启。若产品要求自定义文件夹也默认通知，仅需翻转 §4.5 的 gate 默认值——不影响架构。

## 附录 B：旧 folder_sync 展示模块的处置（接管废弃，决策 D7，更新 2026-06-08）

**实测发现**：旧 folder_sync（存档/草稿箱展示链路）在打包应用中**从未工作**——`MAILBOX_FOLDER_SYNC_ENABLED=true` + davmail + 前端入口全开，但 `folder_sync_state` 表零记录（FolderSyncWorker 从未启动一次 tick）、`folder_email` 表 0 行。一个「装了门面没接管线」的半成品。

**决策：新链路统一接管 + 旧展示链路分阶段废弃**（取代原「正交共存」）：

| 旧组件 | 性质 | 处置 |
|---|---|---|
| `FolderImapReader`（imap_folder_reader.py，IMAP 写底层） | **活**：归档（mail_write.py:659）+ 草稿（draft_service.py）依赖，**本功能写操作泛化（§4.6/§4.8）还要复用** | **永久保留**；P6 迁出 folder_sync（如挪 `src/mail/backend/`），**不删** |
| FolderSyncWorker（worker.py） | 死（从没启动） | 本功能内停用 → P6 删 |
| folder_email / _fts / folder_sync_state 三表 | 死（空） | 本功能保留 → P6 删 migration |
| 老 folder router/CLI 展示端点 + Sidebar 老数据源 | 死 | 本功能切新链路源 → P6 删 |

**本功能内（P1-P5）一律不删旧代码**（diff 干净 + 可回滚）；删除是 **P6 独立 cleanup**，只删确认无依赖的展示链路，**FolderImapReader 不删反而迁移保留**。存档/草稿箱作为可勾选文件夹并入白名单走主链路。
