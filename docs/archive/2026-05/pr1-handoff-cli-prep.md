# PR-1 Handoff: CLI 前置 Refactor

> **Mission**: 实施 RFC v2 §3 + §10 PR-1 — NotionSync strict DI + EmailFull + AttachmentStore 绝对路径 + R-02 thread-relations 切 SQLite + R-03 删 `fetched` + I-01 测试 fix。
>
> **不在 PR-1 scope**：任何 `src/cli/` 的事；CLI 实现在 PR-2 起。
>
> **前置文档**:
> - [`agent-cli-rfc.md`](./agent-cli-rfc.md) — RFC v2（含 §3 前置 refactor 完整设计 + §10 PR-1 变更清单）
> - [`backend-review-2026-05.md`](./backend-review-2026-05.md) — 架构 review（R-01 ~ R-07 出处）
> - [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) — v4 架构
> - [`phase4-complete.md`](./phase4-complete.md) — Phase 4 ship 报告
> - [`../CLAUDE.md`](../CLAUDE.md) — 项目总指南

---

## 1. TL;DR — PR-1 要做什么

| 任务 | 出处 | 变更范围 |
|---|---|---|
| **A. NotionSync strict DI** | RFC §3.1 / R-01 | `src/notion/sync.py` + `src/mail/new_watcher.py` + `src/mail/reverse_sync.py` |
| **B. EmailRepository.get_email_full + get_metadata + ThreadMember** | RFC §3.2 §3.4 / D3 / R-02 | `src/repository/email_repository.py`（新 dataclass + 方法） |
| **C. _handle_thread_relations 切 SQLite SSoT** | RFC §3.4 / R-02 | `src/notion/sync.py` + `src/config.py`（新 flag） |
| **D. AttachmentStore 绝对路径 + 兼容老 local_path** | RFC §3.3 / R-04 | `src/repository/attachment_store.py` |
| **E. 删 fetched 状态 + 同步文档** | RFC §3.5 / R-03 / R-07 | `src/mail/sync_store.py` + `docs/architecture_v4_sqlite_ssot.md` + `CLAUDE.md` + `docs/backend-review-2026-05.md` |
| **F. test_disabled_by_default 加 monkeypatch** | RFC §3.6 / I-01 | `tests/notion/test_create_from_sqlite.py` |
| **G. 单测（5+ 新 fixture）** | RFC §3.6 | `tests/repository/` + `tests/notion/` + `tests/mail/` |

**约束**：
- **不动**：CLI scaffolding、pyproject entrypoint、scripts/* 任何文件
- **不动**：v4 灰度运行时（mail-sync 已 stopped，PR-1 落地后用户重启）
- **必须**：全量 pytest 通过，新增 ≥ 5 个测试用例
- **必须**：CLAUDE.md / architecture_v4 状态机段同步更新（fetched 删除）

---

## 2. 环境状态（开 session 前对齐）

| 项 | 状态 |
|---|---|
| git branch | main，clean（无 uncommitted） |
| 最近 commit | `5d6cf7e docs(v4): Phase 4 → backend review + agent CLI handoff` |
| `data/sync_store.db` `db_version` | 5 |
| 数据规模 | metadata=8493 / body=2397 / fts=2397 / attachments=8425 / derived=365 / notion_file_id=7 |
| `.env` 中 `NOTION_READ_FROM_SQLITE` | true（灰度切了但 pm2 还停着） |
| pm2 mail-sync | stopped（等 backfill 完用户手动 start） |
| `backfill_email_body.py` | 后台跑中（`--since-date 2026-03-01`） |
| pytest 基线 | 294 passed + 1 failed（`test_disabled_by_default`，I-01 已知）|

**开 session 第一件事**：跑 §5 验证命令确认 git 干净、pytest 基线、backfill 进度。

---

## 3. 任务详细规格

### 3.1 任务 A — NotionSync strict DI（R-01）

**目标**：`NotionSync.__init__` 改成必传 `email_repo` + `sync_store`，消灭 `_ensure_sqlite_resources` lazy 创建。

**改动清单**（RFC §3.1 已细化）：

```python
# src/notion/sync.py
class NotionSync:
    def __init__(
        self,
        *,
        email_repo: EmailRepository,
        sync_store: SyncStore,
        client: Optional[NotionClient] = None,    # 仅测试注入用，生产保留 lazy
    ):
        self.client = client or NotionClient()
        self.html_converter = HTMLToNotionConverter()
        self.eml_generator = EMLGenerator()
        self._email_repo = email_repo
        self._sync_store = sync_store

    # 删除：_ensure_sqlite_resources()
    # 删除：_repo / _sync_store 的 Optional 标注
```

**调用点改造**：

| 位置 | 改动 |
|---|---|
| `src/mail/new_watcher.py:119` | `self.notion_sync = NotionSync(email_repo=self.email_repo, sync_store=self.sync_store)` |
| `src/mail/reverse_sync.py:40` | 改 `NotionToMailSync.__init__` 让 caller 注入 `notion_sync`；不传时 raise（不再 auto-construct） |
| `scripts/resync_notion.py` | 显式 `NotionSync(email_repo=repo, sync_store=ss)`（PR-1 内最小改动，仍是脚本） |

**`create_email_page_v2` wrapper 灰度路由**（line 1004-1038）：
- 删除内联的 `self._ensure_sqlite_resources()`，直接用 `self._email_repo` / `self._sync_store`
- 保留三态语义（开关 false / true+命中 / true+miss fallback）
- 保留所有 debug log

**测试**：现有 `tests/notion/test_create_from_sqlite.py` 大量使用 `_bare_notion_sync()` fixture（line 558 附近）。新增的 strict DI 让 fixture 必须传 repo + ss。更新所有依赖 fixture 的 21 个 case。

### 3.2 任务 B — EmailFull / ThreadMember dataclass + 方法

**目标**：让 CLI 与 caller 走单一 SSoT 接口，不再 caller 持有 sync_store + repo 两个对象。

**新增 dataclass**（`src/repository/email_repository.py`）：

```python
@dataclass
class EmailMetadataRecord:
    """email_metadata 行 dataclass 投影（替代 Dict 出口）。"""
    internal_id: int
    message_id: Optional[str]
    thread_id: Optional[str]
    subject: str
    sender: str
    sender_name: Optional[str]
    to_addr: str
    cc_addr: str
    date_received: Optional[str]
    mailbox: str
    is_read: bool
    is_flagged: bool
    sync_status: str
    notion_page_id: Optional[str]
    notion_thread_id: Optional[str]
    sync_error: Optional[str]
    retry_count: int
    next_retry_at: Optional[float]
    created_at: float
    updated_at: float

    @property
    def notion_url(self) -> Optional[str]:
        if not self.notion_page_id:
            return None
        return f"https://www.notion.so/{self.notion_page_id.replace('-', '')}"


@dataclass
class EmailFull:
    internal_id: int
    metadata: EmailMetadataRecord
    body: Optional[EmailBodyRecord]
    attachments: list[AttachmentRecord]


@dataclass
class ThreadMember:
    internal_id: int
    page_id: Optional[str]              # email_metadata.notion_page_id
    date_received: Optional[str]
    is_synced: bool                     # sync_status == 'synced'
```

**新增方法**:

```python
class EmailRepository:
    def get_metadata(self, internal_id: int) -> Optional[EmailMetadataRecord]: ...
    
    def get_email_full(self, internal_id: int) -> Optional[EmailFull]: ...
    
    def get_thread_members(
        self,
        thread_id: str,
        *,
        exclude_internal_id: Optional[int] = None,
        synced_only: bool = True,
    ) -> list[ThreadMember]: ...
```

**实现要点**:
- `get_metadata`: SELECT 所有 email_metadata 列，构造 dataclass
- `get_email_full`: 内部串调 get_metadata + get_body + get_attachments
- `get_thread_members`: 复用 `sync_store.get_all_emails_by_thread_id` 的 SQL 语义，但返回 dataclass list

**注意**：`SyncStore.get_all_emails_by_thread_id` 仍保留（其他路径在用）。

### 3.3 任务 C — `_handle_thread_relations` 切 SQLite SSoT（R-02）

**目标**：`_handle_thread_relations` 优先从 SQLite 查 thread members，Notion API fallback。

**改造**（`src/notion/sync.py:1305-1372`）：

```python
async def _handle_thread_relations(self, page_id: str, email: Email):
    thread_id = email.thread_id
    if not thread_id:
        return

    try:
        # 1. SQLite 优先
        members = self._email_repo.get_thread_members(
            thread_id=thread_id,
            exclude_internal_id=email.internal_id,
            synced_only=True,
        )
        
        # 2. Notion fallback（灰度期）
        if not members and app_config.thread_relations_fallback_to_notion:
            members_raw = await self._find_all_thread_members_with_date(
                thread_id, exclude_message_id=email.message_id
            )
            # 转 ThreadMember dataclass
            members = [
                ThreadMember(
                    internal_id=-1,            # Notion 路径无 internal_id
                    page_id=m['page_id'],
                    date_received=m.get('date', ''),
                    is_synced=True,
                )
                for m in members_raw
            ]

        if not members:
            logger.debug(f"No thread members for {thread_id[:30]}")
            return

        # 3. page_id 健康检查（防止 SQLite 中的 page_id 已 archive）
        valid_members = []
        for m in members:
            if not m.page_id:
                continue
            # 灰度期可以选择跳过 check_page_exists 以减少 Notion 调用
            valid_members.append(m)
        
        if not valid_members:
            return

        # 4. 与 v1 同的日期比较 + sub-item 设置逻辑
        # ...（保留 _parse_date_to_beijing + 日期比较 + update_sub_items）
```

**新增配置**（`src/config.py`）:

```python
thread_relations_fallback_to_notion: bool = Field(
    default=True, env="THREAD_RELATIONS_FALLBACK_TO_NOTION",
    description=(
        "_handle_thread_relations 在 SQLite 查不到 thread members 时是否 fallback "
        "Notion API（v4 R-02 灰度期开关；historic backfill 完成后可关）"
    ),
)
```

**测试**：
- `tests/repository/test_email_repository.py::TestGetThreadMembers`（单元）
- `tests/notion/test_thread_relations_sqlite_first.py`（mock repo 返回 members / 空，验证 fallback 路径）

### 3.4 任务 D — AttachmentStore 绝对路径（R-04）

**目标**：解除 CLI cwd 依赖（让 `mailagent attachment download` 可从任意目录跑）。

**改造**（`src/repository/attachment_store.py`）：

```python
class AttachmentStore:
    def __init__(self, base_dir: str | Path = "data/attachments"):
        # 改：构造时 resolve 绝对路径
        self.base_dir = Path(base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def relative_path(self, internal_id, filename):
        # 不变：仍返回 "data/attachments/{int_id}/{filename}" 形式（与 SQLite 存的兼容）
        safe = self.sanitize_filename(filename)
        return str(Path("data/attachments") / str(internal_id) / safe)

    def read(self, local_path):
        p = Path(local_path)
        if p.is_absolute():
            return p.read_bytes()
        # **关键改动**：以 base_dir 反推项目根，不用 Path.cwd()
        # local_path = "data/attachments/53675/file.pdf"
        # base_dir = ".../MailAgent/data/attachments"
        # project_root = base_dir.parent.parent = ".../MailAgent"
        project_root = self.base_dir.parent.parent
        return (project_root / p).read_bytes()

    def exists(self, local_path):
        # 同上改造
        ...
```

**测试**：`tests/repository/test_attachment_store.py::TestAbsolutePath`
- 从 `/tmp` 调用 `read()` 也能拿到 bytes
- `base_dir` 是相对路径时 `__init__` 后变绝对

### 3.5 任务 E — 删 `fetched` 状态（R-03 + R-07）

**目标**：`fetched` 是死代码（无 mark_fetched 写入），从所有声明处删除。

**改动清单**：

| 文件:行 | 改动 |
|---|---|
| `src/mail/sync_store.py:81` | `EmailMetadata` TypedDict 的 `sync_status` 注释删 `fetched` |
| `src/mail/sync_store.py:1302` | `get_emails_by_status` docstring 删 `fetched` |
| `docs/architecture_v4_sqlite_ssot.md` | 状态流转段（搜 "fetched"）更新为 6 状态 |
| `CLAUDE.md` | "状态流转"段（搜 "fetched"）更新为 6 状态 |
| `docs/backend-review-2026-05.md` | I-02 / R-03 标 fixed（在条目末尾加 `→ 已 fix in PR-1 (commit XXX)`） |

**测试**：`tests/mail/test_sync_store_status_machine.py`（新增）
- assert `get_emails_by_status('fetched')` 永远返回 `[]`
- assert TypedDict 的 sync_status 注释不再含 'fetched'（用 inspect 校验）

### 3.6 任务 F — test_disabled_by_default 修复（I-01）

**文件**：`tests/notion/test_create_from_sqlite.py:574-608`

**改造**：在测试函数开头加：

```python
from src.config import config as app_config
monkeypatch.setattr(app_config, "notion_read_from_sqlite", False)
```

这样测试不再依赖 `.env` 真值（用户切了 `NOTION_READ_FROM_SQLITE=true` 后该 case 必败）。

### 3.7 任务 G — 综合测试要求

PR-1 完成时 pytest 必须满足：

```bash
$ pytest tests/ -q --tb=short
... 全部 passed（≥ 296 passed，v1 295 + R-02 / R-03 / R-04 / EmailFull 新增）
```

**新增测试文件**：
1. `tests/repository/test_email_repository.py::TestGetEmailFull`
2. `tests/repository/test_email_repository.py::TestGetMetadata`
3. `tests/repository/test_email_repository.py::TestGetThreadMembers`
4. `tests/repository/test_attachment_store.py::TestAbsolutePath`
5. `tests/notion/test_thread_relations_sqlite_first.py`（新文件）
6. `tests/mail/test_sync_store_status_machine.py`（新文件）

**修改的测试**：
- `tests/notion/test_create_from_sqlite.py`：所有 21 个 case 改用新 strict DI 的 NotionSync fixture
- `tests/notion/test_create_from_sqlite.py::test_disabled_by_default`：加 monkeypatch

---

## 4. 实施顺序建议

按依赖串行（同一 PR 内分 commit）：

1. **Commit 1**: D3 EmailFull + dataclass + get_metadata + get_email_full + 单测
2. **Commit 2**: R-02 ThreadMember + get_thread_members + 单测
3. **Commit 3**: R-01 NotionSync strict DI + 调用点改造 + 现有测试 fixture 修
4. **Commit 4**: R-02 `_handle_thread_relations` 切 SQLite + 新单测
5. **Commit 5**: R-04 AttachmentStore 绝对路径 + 单测
6. **Commit 6**: R-03 删 fetched（代码 + 注释） + 新单测
7. **Commit 7**: R-07 文档同步（CLAUDE.md / architecture / backend-review）
8. **Commit 8**: I-01 test_disabled_by_default monkeypatch
9. **Commit 9**: 综合回归 + 最终 lint（如有）

或者按 RFC §10 PR-1 描述的"一个 PR 多个 commits" 节奏，commits 串行 + 单 PR。

---

## 5. 验证 / 入门命令

```bash
# 1. 状态确认
git status
git log --oneline -5
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"   # 期望 5

# 2. 验证当前 pytest 状态
source venv/bin/activate
pytest tests/ -q --tb=no | tail -3
# 期望 294 passed + 1 failed（test_disabled_by_default）

# 3. 关键文件读一遍
# - src/repository/email_repository.py（534 行）
# - src/repository/attachment_store.py（161 行）
# - src/notion/sync.py（1745 行，重点看 _handle_thread_relations / _ensure_sqlite_resources / create_email_page_v2 wrapper）
# - src/mail/new_watcher.py:119（NotionSync 构造点）
# - src/mail/reverse_sync.py:40（NotionToMailSync 内部 NotionSync 构造）
# - src/mail/sync_store.py:81, 1302（fetched 注释位置）
# - tests/notion/test_create_from_sqlite.py:574-608（test_disabled_by_default + 21 个 case 用的 _bare_notion_sync fixture）

# 4. 灰度状态确认
grep NOTION_READ_FROM_SQLITE .env                            # 期望 =true
pm2 status mail-sync                                          # 期望 stopped
ps aux | grep backfill_email_body | grep -v grep             # backfill 可能仍在跑

# 5. 跑完 PR-1 实施后回归
pytest tests/ -q --tb=short | tail -5
# 期望 296+ passed, 0 failed
```

---

## 6. 约束 / 不要做的事

- **不动 CLI**：`src/cli/` 不创建，pyproject 不加 `[project.scripts]`，这是 PR-2 的事
- **不动 scripts/**：scripts/* 任何文件都不 mv 不删，这是 PR-5 的事
- **不动 v4 灰度配置**：`.env` 中 `NOTION_READ_FROM_SQLITE` 不变（true），PM2 不 start
- **不动 backfill 进程**：backfill 仍在跑，用户决定何时停 + 启 mail-sync
- **不破坏老路径**：v2 wrapper 灰度路由（false / true+hit / true+miss）三态保留，**只是不用 lazy init 了**
- **不引入新依赖**：PR-1 不加 typer / rich / pyyaml（PR-2 才加）
- **不擅自改其他 P2/P3 issues**：I-04 / I-05（已含 R-04） / I-06（已含 R-02） / I-07 / I-08 / I-09 / I-10 / I-11 / I-12 / I-13 / I-14 都不在 PR-1 scope

---

## 7. 完成检查清单

PR-1 提交前必须 ✅:

- [ ] `pytest tests/ -q` 全绿（≥ 296 passed）
- [ ] `tests/notion/test_create_from_sqlite.py::test_disabled_by_default` 通过（不依赖 `.env` 真值）
- [ ] `NotionSync()` 无参构造抛 TypeError（strict DI 生效）
- [ ] `from data/attachments` 之外的目录跑 `python -c "from src.repository import EmailRepository; print(EmailRepository().get_attachment_bytes(1024))"` 不报 cwd 相关错
- [ ] `git grep -i "fetched" src/mail/sync_store.py docs/architecture_v4_sqlite_ssot.md CLAUDE.md` 无残留（除 commit message 和注释里说"已删 fetched 状态"的部分）
- [ ] `git grep "_ensure_sqlite_resources" src/notion/sync.py` 无残留
- [ ] CLAUDE.md / architecture / backend-review 三处文档已同步
- [ ] commit message 引用 RFC v2 § + backend-review I-XX / R-XX 编号
- [ ] PR 描述含变更总览 + 测试结果 + 回滚说明

---

## 8. 启动 prompt（新 session 复制粘贴）

```
开始实施 RFC v2 PR-1: CLI 前置 Refactor（NotionSync DI + EmailFull + R-02 thread relations + R-03 删 fetched + R-04 AttachmentStore 绝对路径 + I-01 fix）。

前置文档：
- docs/pr1-handoff-cli-prep.md（本文档，含完整任务规格 + 实施顺序 + 验证）
- docs/agent-cli-rfc.md §3 + §10 PR-1（设计原文）
- docs/backend-review-2026-05.md（R-01~R-07 出处）

按 §4 实施顺序逐 commit 推进。每个 commit 前确保 pytest 不破坏现有路径。

约束：
- PR-1 不动 CLI / scripts/* / pyproject / 灰度运行时配置
- 完成时 pytest ≥ 296 passed，必须修复 test_disabled_by_default I-01
- 文档同步：CLAUDE.md / architecture_v4 / backend-review 三处一起改

关键决策点用 AskUserQuestion 对齐再推进。
```

---

> 本 handoff 由 RFC v2 §3 + §10 PR-1 派生。等 PR-1 ship + merge 后，PR-2 (CLI scaffolding) handoff 另开。
