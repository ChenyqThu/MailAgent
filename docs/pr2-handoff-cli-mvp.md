# PR-2 Handoff: CLI 骨架 + MVP 命令

> **Mission**: 落地 `mailagent` CLI 骨架 + MVP 命令（email get/list/body/search/resync + admin stats/health/db-version）。
>
> **不在 PR-2 scope**：attachment / llm / backfill / notion / project-progress / init / calendar / debug 子命令（PR-3/PR-4 范围）。长任务契约 / PM2 检测 / checkpoint resume 全在 PR-4。
>
> **前置文档**:
> - [`agent-cli-rfc.md`](./agent-cli-rfc.md) — RFC v2（含 §4 命令树 / §5 通用约定 / §6 实现架构 / §7 JSON Schema）
> - [`pr1-handoff-cli-prep.md`](./pr1-handoff-cli-prep.md) — PR-1（已 ship 8 commits）
> - [`backend-review-2026-05.md`](./backend-review-2026-05.md) — 架构 review
> - [`../CLAUDE.md`](../CLAUDE.md) — 项目总指南

---

## 1. TL;DR — PR-2 要做什么

| 任务 | 出处 | 变更范围 |
|---|---|---|
| **A. pyproject.toml CLI 入口** | RFC §6.5 | `pyproject.toml` 新加 `[project.scripts]` + `[project.optional-dependencies].cli` |
| **B. src/cli/ 骨架** | RFC §6.1 / §6.3 / §6.4 | `src/cli/{__init__,main,context,output,auth,exceptions,config}.py` |
| **C. email 子命令 MVP** | RFC §4.2 | `src/cli/commands/email.py`：`get / list / body / search / resync` (单封) |
| **D. admin 子命令 MVP** | RFC §4.8 | `src/cli/commands/admin.py`：`stats / health / db-version` |
| **E. JSON Schema MVP** | RFC §7.0 / §7.1-7.5 | `docs/cli-schema/_common.schema.json` + 6 个命令 schema + `error-codes.md` |
| **F. 单测** | RFC §6.6 | `tests/cli/test_{email,admin}.py` + `test_config_factory.py` + `test_typer_help_snapshot.py` |
| **G. CLAUDE.md 加 CLI 章节（简版）** | RFC §10 PR-2 | `CLAUDE.md` 顶部 / 命令速查段 |

**约束**：
- **不动**：PR-1 已 ship 的 src/repository、src/notion、src/mail/sync_store、src/config 等（除新加 `mailagent_cli_api_key` Field）
- **不动**：scripts/* 任何 thin wrapper（PR-5 范围）
- **不动**：长任务 batch 契约 / PM2 检测 / checkpoint（PR-4 范围）
- **不动**：attachment / llm / backfill / notion / project-progress / init / calendar / debug 子命令（PR-3/PR-4）
- **不动**：v4 灰度运行时配置（NOTION_READ_FROM_SQLITE=true 保持）
- **必须**：`pip install -e ".[cli]"` 后 `mailagent --help` 可用、`mailagent email get 53675 -o json` 输出符合 schema
- **必须**：新增 ≥ 15 个 CLI test（typer CliRunner mock）
- **预估**：2 天（RFC §10 PR-2）

---

## 2. 环境状态（开 session 前对齐）

| 项 | 状态 |
|---|---|
| git branch | main，clean（PR-1 已 ship） |
| 最近 commit | `7c33d06 fix(tests): test_disabled_by_default monkeypatch ... (PR-1 Commit 8 / I-01)` |
| PR-1 commits | 8 个（`0f321a4` ~ `7c33d06`）|
| pytest 基线 | **323 passed**（PR-1 ship 报告）|
| NotionSync 接口 | strict DI（必传 `email_repo` + `sync_store`）|
| EmailRepository | 含 `get_metadata / get_email_full / get_thread_members` |
| AttachmentStore | 绝对路径，不依赖 cwd |
| `data/sync_store.db` `db_version` | 5 |
| 数据规模（截至 PR-1 ship） | metadata=8493 / body=2397 / fts=2397 / attachments=8425 / derived=365 / notion_file_id=7 |
| `.env` 中 `NOTION_READ_FROM_SQLITE` | true（灰度仍切，pm2 仍停） |
| pm2 mail-sync | stopped |
| backfill 进程 | 已停 |

**开 session 第一件事**：跑 §5 验证命令确认 PR-1 状态完整，再开始 PR-2。

---

## 3. 任务详细规格

### 3.1 任务 A — pyproject.toml CLI 入口

**改动**：`pyproject.toml`（已存在，含 `[project]` 段）

加：
```toml
[project.scripts]
mailagent = "src.cli.main:app"

[project.optional-dependencies]
cli = [
    "typer>=0.12,<0.14",       # PR-2 pin 上限（RFC §6.5 / S6）
    "rich>=13,<15",            # 表格 + 颜色
    "pyyaml>=6,<7",            # yaml output
]
```

**版本口径**（RFC §6.5 / S7）:
- Package：`requires-python = ">=3.9"`（不变，与 webhook-server 远程 VPS 一致）
- CLI tested on macOS Python 3.11+（与 main.py / pm2 一致）

**验证**：
```bash
pip install -e ".[cli]"
which mailagent                # 应是 venv/bin/mailagent
mailagent --version            # 出 version
mailagent --help               # 列资源 + global flags
mailagent --install-completion zsh   # typer 自带（可选）
```

### 3.2 任务 B — src/cli/ 骨架

**新增文件**（按 RFC §6.1）：

```
src/cli/
├── __init__.py
├── main.py              # typer App + 注册 email / admin
├── context.py           # CliContext: 持有 repo / sync_store / notion_sync 单例
├── config.py            # load_cli_config factory（RFC §5.4 / C9）
├── output.py            # text / json / yaml / ndjson 渲染
├── auth.py              # API key 校验（RFC §5.3 / C8）
├── exceptions.py        # CliError + exit_code 映射（RFC §5.2）
└── commands/
    ├── __init__.py
    ├── email.py
    └── admin.py
```

**关键设计点**（每个 file 简述，详细 spec 见 RFC）：

#### `src/cli/main.py`

```python
import typer
from src.cli.commands import email, admin
from src.cli.context import CliContext

app = typer.Typer(
    name="mailagent",
    help="MailAgent CLI - Agent-friendly interface to the MailAgent backend.",
    no_args_is_help=True,
)

app.add_typer(email.app, name="email", help="邮件 CRUD / 搜索 / 重传")
app.add_typer(admin.app, name="admin", help="统计 / 健康 / db-version")


@app.callback()
def main(
    ctx: typer.Context,
    output: str = typer.Option("text", "-o", "--output"),
    quiet: bool = typer.Option(False, "-q", "--quiet"),
    verbose: bool = typer.Option(False, "-v", "--verbose"),
    db_path: str = typer.Option(None, "--db-path"),
    api_key: str = typer.Option(None, "--api-key"),
    config: str = typer.Option(None, "--config"),
    no_color: bool = typer.Option(False, "--no-color"),
    version: bool = typer.Option(False, "--version", is_flag=True, is_eager=True,
        callback=_print_version),
):
    """Global flags handler."""
    ctx.obj = CliContext.from_flags(
        output=output, quiet=quiet, verbose=verbose,
        db_path=db_path, api_key=api_key,
        config=config, no_color=no_color,
    )
```

`--output ndjson` 是独立 flag，**不**与 `json` 合并（RFC §5.1.4 / C6）。

#### `src/cli/context.py`

```python
@dataclass
class CliContext:
    """长寿命对象集中点：lazy-init 但每个 process 一次."""
    output: str = "text"
    quiet: bool = False
    verbose: bool = False
    db_path: Optional[str] = None
    api_key: Optional[str] = None
    config_path: Optional[str] = None
    no_color: bool = False

    _email_repo: Optional[EmailRepository] = None
    _sync_store: Optional[SyncStore] = None
    _notion_sync: Optional[NotionSync] = None
    _cli_config: Optional[Config] = None      # 通过 load_cli_config 创建

    @classmethod
    def from_flags(cls, **kw) -> "CliContext":
        ctx = cls(**kw)
        ctx._cli_config = load_cli_config(
            config_path=ctx.config_path,
            flag_overrides={
                "sync_store_db_path": ctx.db_path,
                "mailagent_cli_api_key": ctx.api_key,
            },
        )
        return ctx

    @property
    def email_repo(self) -> EmailRepository:
        if self._email_repo is None:
            cfg = self._cli_config
            self._email_repo = EmailRepository(
                db_path=cfg.sync_store_db_path,
                attachment_store=AttachmentStore(cfg.attachment_storage_dir),
            )
        return self._email_repo

    @property
    def sync_store(self) -> SyncStore: ...

    @property
    def notion_sync(self) -> NotionSync:
        """用 PR-1 strict DI 接口构造。"""
        if self._notion_sync is None:
            self._notion_sync = NotionSync(
                email_repo=self.email_repo, sync_store=self.sync_store,
            )
        return self._notion_sync

    def require_auth(self) -> None:
        """写命令前调；失败 raise CliAuthError (exit 4)."""
        auth.require_auth(self)
```

#### `src/cli/config.py`

实现 RFC §5.4 / C9 的 `load_cli_config` factory（不依赖 `from src.config import config` 全局 singleton）：

```python
def load_cli_config(
    config_path: Optional[str] = None,
    env_overrides: Optional[dict] = None,
    flag_overrides: Optional[dict] = None,
) -> Config:
    env_file = config_path or ".env"
    base = Config(_env_file=env_file)
    for k, v in (env_overrides or {}).items():
        if v is not None:
            setattr(base, k, v)
    for k, v in (flag_overrides or {}).items():
        if v is not None:
            setattr(base, k, v)
    return base
```

`src/config.py` 加一个新 Field `mailagent_cli_api_key: str = Field(default="", env="MAILAGENT_CLI_API_KEY", description="...")`。

#### `src/cli/output.py`

```python
def emit(ctx, data, *, ndjson=False, meta_extra=None) -> None:
    """Render data per ctx.output. text/json/yaml/ndjson."""
    if ctx.output == "ndjson":
        # caller 负责传 data: Iterable[dict]
        for item in data:
            print(json.dumps(item, ensure_ascii=False, default=str))
        # 最后一行 _meta
        meta = {"duration_ms": ctx.elapsed_ms(), **(meta_extra or {})}
        print(json.dumps({"_meta": meta}, ensure_ascii=False))
    elif ctx.output == "json":
        payload = {
            "status": "success",
            "schema_version": 1,
            "data": data,
            "meta": {"duration_ms": ctx.elapsed_ms(), **(meta_extra or {})},
        }
        print(json.dumps(payload, ensure_ascii=False, default=str))
    elif ctx.output == "yaml":
        yaml.dump({"status": "success", "schema_version": 1,
                   "data": data, "meta": {...}}, sys.stdout, allow_unicode=True)
    else:
        _render_text(ctx, data)


def emit_error(ctx, code, message, *, exit_code=1, hint=None, context=None):
    """JSON/YAML 模式输出到 stderr；text 模式输出 Error: ...."""
    ...
    raise typer.Exit(code=exit_code)
```

#### `src/cli/auth.py`

按 RFC §5.3 / C8 实现 `require_auth(ctx)`：默认拒绝（除非 `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true`），用 `hmac.compare_digest` 比对。

#### `src/cli/exceptions.py`

```python
class CliError(Exception):
    code: str
    exit_code: int = 1

class CliAuthError(CliError):
    code = "E_AUTH_FAILED"
    exit_code = 4

class CliNotFoundError(CliError):
    code = "E_NOT_FOUND"
    exit_code = 1

class CliInvalidArgError(CliError):
    code = "E_INVALID_ARG"
    exit_code = 2

class CliSchemaError(CliError):
    code = "E_SCHEMA_MISMATCH"
    exit_code = 5
```

### 3.3 任务 C — email 子命令 MVP

**新增 `src/cli/commands/email.py`**，含 5 个命令：

#### `mailagent email get <internal_id> [--include {body,attachments,all}]`

读 → emit。用 `cli.email_repo.get_metadata` 或 `get_email_full`。schema 见 §7.1。

#### `mailagent email list [flags]`

flags 见 RFC §4.2。SQL 走 `sync_store.search_emails` 或 `repo.iter_emails`（PR-2 内不写新 repo 方法，复用现有 `sync_store.search_emails` 即可，注意它的 fields 限制）。

输出：
- `text` (default): 表格（rich.table）
- `json`: wrapper object with data array
- `ndjson` / `--stream`: 每行一邮件 + 最后 `_meta`

`--source mail` 走 `SQLiteRadar.search_all_emails`（已存在），`--source syncstore`（default）走 `sync_store.search_emails`。

#### `mailagent email body <internal_id> [--format {markdown,html,raw}]`

- markdown (default): `repo.get_body_markdown` 输出到 stdout
- html: `repo.get_body_html`
- raw: `repo.get_body().raw_mime_sha256`（仅哈希，不返回 MIME，body 太大）
- `-o json`: `{format, content, size_bytes, fetched_at, fetched_source}`

#### `mailagent email search <query> [flags]`

调 `repo.search_email_bodies(query, ...)`。
- text: 表格 + snippet 高亮
- json wrapper: data array
- ndjson: 每行 hit + `_meta`

flags 包含 `--mailbox / --since / --until / --limit / --no-snippet`。

#### `mailagent email resync <internal_id> [flags]`（PR-2 仅单封 + dry-run）

单封 + `--dry-run / --replace-existing / --no-parent`。`--range / --ids / --max-failures / --resume-from / --progress-every` 是 PR-4 batch 模式范围，**不在 PR-2 scope**（CLI 接受 flag 但仅警告"PR-4 才支持"）。

底层调 `notion_sync.create_email_page_from_sqlite(internal_id, repo=..., sync_store=..., replace_existing=..., skip_parent_lookup=...)`。

**写命令**：`ctx.require_auth()` 先调（除非 `--dry-run`）。

### 3.4 任务 D — admin 子命令 MVP

**新增 `src/cli/commands/admin.py`**：

#### `mailagent admin stats`

实现 RFC §7.5 的 schema（**仅 PR-2 范围**：watcher / sync_store / handlers 三段，**`v4_rollout` 留 PR-4 落 R-06**）。

```json
{
  "status": "success",
  "data": {
    "watcher": {"_source": "not_implemented_in_pr2"},
    "sync_store": {
      "total_emails": ...,
      "by_status": {...},
      "db_size_mb": ...,
      "_source": "live_query"
    },
    "handlers": {"_source": "not_implemented_in_pr2"},
    "v4_rollout": {"_source": "not_implemented_in_pr2"}
  }
}
```

PR-2 实测的是 `sync_store` section（直接查 SQLite），其他段标 `_source: "not_implemented_in_pr2"`。PR-4 时把 v4_rollout 持久化 + 把 watcher / handlers 接 stats_reporter snapshot。

#### `mailagent admin health`

简单 SQLite 连通性 + db_version 检查。

```json
{
  "status": "success",
  "data": {
    "db_path": "/.../sync_store.db",
    "db_accessible": true,
    "db_version": 5,
    "db_version_expected": 5,
    "schema_ok": true,
    "tables_present": ["email_metadata", "email_body", "email_attachment", "email_body_fts"]
  }
}
```

不调 Notion API（健康检查应快），不阻塞。

#### `mailagent admin db-version`

```json
{"status": "success", "data": {"version": 5, "expected": 5, "compatible": true}}
```

或 text：`5 (expected: 5, compatible: yes)`。

### 3.5 任务 E — JSON Schema MVP

**新增**（按 RFC §7.0 placeholder 清单的 MVP 子集）：

```
docs/cli-schema/
├── _common.schema.json        # 顶层 wrapper / error / meta 通用 schema
├── error-codes.md             # error.code enum 列表（含 E_NOT_FOUND / E_AUTH_FAILED 等）
├── email-get.schema.json
├── email-list.schema.json
├── email-body.schema.json
├── email-search.schema.json
├── email-resync.schema.json
├── admin-stats.schema.json
├── admin-health.schema.json
└── admin-db-version.schema.json
```

`_common.schema.json` 定义 wrapper / error / meta / partial_failure，其他文件 `$ref` 它。所有 schema 用 `$schema: "https://json-schema.org/draft/2020-12/schema"` + `additionalProperties: false`。

参考 RFC §7.1-7.5 的具体字段示例。

**约束**：
- 字段拆数字 vs 字符串（如 `priority_key` + `priority_label` 双字段）—— 但 PR-2 不涉及 LLM 输出，主要是 email metadata，自然就是 typed 字段
- 时间格式统一 ISO 8601 含时区
- 错误 schema 引用 `error-codes.md` 的 enum

### 3.6 任务 F — 单测

**新增**：

```
tests/cli/
├── __init__.py
├── conftest.py                # fixture: cli_runner / tmp_db / seed_email / mocked_notion_client
├── test_email.py              # 5 个 email 命令 happy / not-found / output format
├── test_admin.py              # 3 个 admin 命令 happy / output format
├── test_config_factory.py     # load_cli_config 优先级测试（RFC §5.4）
├── test_typer_help_snapshot.py # mailagent --help 各级 snapshot
└── test_auth.py               # require_auth 各分支（含 unsafe-flag）
```

每个命令 ≥ 3 个 case：
1. happy path（mock DB 命中）
2. not-found（exit 1 + E_NOT_FOUND）
3. output format（`-o json` 输出可 `json.loads` 解析 + schema 校验）

**至少 15 个 test case**。

### 3.7 任务 G — CLAUDE.md 加 CLI 章节

在 CLAUDE.md 顶部"项目概述"之后、"命令速查"之前，加：

```markdown
## CLI（v4 Phase 5 起接管 scripts/*）

`mailagent` CLI 提供 agent-friendly 接口给本机调用 / 外部 agent / 看板。

**安装**：
\`\`\`bash
pip install -e ".[cli]"
mailagent --help
\`\`\`

**当前 (PR-2 MVP) 支持的命令**：
- `email get/list/body/search/resync` — RFC §4.2
- `admin stats/health/db-version` — RFC §4.8

**详细 spec**: [docs/agent-cli-rfc.md](./docs/agent-cli-rfc.md) §4
**JSON Schema 契约**: [docs/cli-schema/](./docs/cli-schema/)

PR-3 / PR-4 后续加 attachment / llm / backfill / notion / project-progress / init / calendar / debug 子命令。scripts/* 在 PR-5 迁移；当前仍可用。
```

CLAUDE.md "命令速查"段**暂不动**（PR-5 一次全替换）。

---

## 4. 实施顺序建议

PR-2 拆 6-9 commits，每个 commit 都过 pytest：

1. **Commit 1**: pyproject.toml + src/cli/__init__.py + main.py 骨架 + config.py（typer App 跑通 `mailagent --help` + `--version`）
2. **Commit 2**: src/cli/context.py + auth.py + exceptions.py + output.py（基础设施）
3. **Commit 3**: src/cli/commands/email.py — get / body 命令 + schema MVP
4. **Commit 4**: src/cli/commands/email.py — list / search（输出格式覆盖 text / json / ndjson）
5. **Commit 5**: src/cli/commands/email.py — resync（单封 + dry-run；写命令含 auth）
6. **Commit 6**: src/cli/commands/admin.py — stats / health / db-version
7. **Commit 7**: docs/cli-schema/ — 10 个 schema 文件 + error-codes.md
8. **Commit 8**: tests/cli/ — 全部单测（≥ 15 cases）
9. **Commit 9**: CLAUDE.md CLI 章节 + 综合回归

---

## 5. 验证 / 入门命令

```bash
# 1. PR-1 状态确认
git log --oneline -8                                    # 应见 PR-1 8 个 commit
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"   # 期望 5

# 2. 验证 PR-1 baseline pytest
source venv/bin/activate
pytest tests/ -q --tb=no | tail -2
# 期望 323 passed

# 3. PR-2 实施完成后回归
pip install -e ".[cli]"
which mailagent
mailagent --help
mailagent --version

mailagent email get 53675                              # text
mailagent email get 53675 -o json | jq .data.subject   # json
mailagent email get 99999 -o json                      # not-found → exit 1
mailagent email list --mailbox 收件箱 --limit 5
mailagent email search "redis" -o ndjson | tail -2
mailagent email body 53675 --format markdown | head -20
mailagent email resync 53675 --dry-run

mailagent admin stats -o json | jq .data.sync_store.total_emails
mailagent admin health
mailagent admin db-version

# 4. 单测全绿
pytest tests/cli/ tests/ -q --tb=short | tail -5
# 期望 ≥ 338 passed（PR-1 的 323 + PR-2 ≥ 15）
```

---

## 6. 约束 / 不要做的事

- **不动 scripts/***：所有 scripts/ 改造留 PR-5
- **不动 attachment / llm / backfill / notion / project-progress / init / calendar / debug 子命令**：这些是 PR-3/PR-4 范围
- **不实现长任务契约**：`--range / --ids / --max-failures / --resume-from / --progress-every` 是 PR-4，PR-2 仅单封 + dry-run
- **不接 v4_rollout 监控**：admin stats 的 v4_rollout 段标 `_source: "not_implemented_in_pr2"`，PR-4 落 R-06
- **不动 v4 灰度配置**：NOTION_READ_FROM_SQLITE 不变
- **不引入新依赖**（除 typer + rich + pyyaml）
- **不擅自改 PR-1 已 ship 的接口**：EmailRepository / NotionSync / SyncStore 接口保持

---

## 7. 完成检查清单

PR-2 提交前必须 ✅:

- [ ] `pip install -e ".[cli]"` 成功
- [ ] `which mailagent` 指 venv/bin/mailagent
- [ ] `mailagent --help` 显示 email + admin 两组命令 + global flags
- [ ] `mailagent --version` 输出 version
- [ ] `mailagent email get 53675 -o json` 输出符合 `docs/cli-schema/email-get.schema.json`
- [ ] `mailagent email get 99999 -o json` exit 1，含 `error.code = "E_NOT_FOUND"`
- [ ] `mailagent email list -o json` 输出 wrapper object
- [ ] `mailagent email list -o ndjson` 末行是 `{"_meta": {...}}`
- [ ] `mailagent email search "redis" -o json` 输出含 `bm25 rank` 和 `snippet`
- [ ] `mailagent email body 53675` 输出 markdown
- [ ] `mailagent email resync 53675 --dry-run` plan 输出（不写 Notion）
- [ ] `mailagent admin stats -o json` 输出含 sync_store.by_status + db_size_mb
- [ ] `mailagent admin health` 检 db_version
- [ ] `mailagent admin db-version` 输出 5
- [ ] pytest 全绿（≥ 338 passed = PR-1 323 + PR-2 ≥ 15）
- [ ] `tests/cli/test_typer_help_snapshot.py` 通过
- [ ] `docs/cli-schema/` 10 个 schema 文件就位
- [ ] `error-codes.md` 列 ≥ 5 个 E_* 枚举
- [ ] CLAUDE.md CLI 章节就位
- [ ] commit message 引用 RFC §4 / §5 / §6 / §7

---

## 8. 启动 prompt（新 session 复制粘贴）

```
开始实施 RFC v2 PR-2: CLI 骨架 + MVP 命令（email get/list/body/search/resync + admin stats/health/db-version）。

前置文档：
- docs/pr2-handoff-cli-mvp.md（本文档，含完整任务规格 + 实施顺序 + 验证）
- docs/agent-cli-rfc.md §4 + §5 + §6 + §7（设计原文）
- docs/pr1-handoff-cli-prep.md（PR-1 已 ship 8 commits，323 passed）

按 §4 实施顺序逐 commit 推进。每个 commit 前确保 pytest 不破坏现有 323 passed。

约束：
- PR-2 不动 scripts/* / attachment / llm / backfill / notion / project-progress / init / calendar / debug 子命令
- 长任务契约（batch / PM2 检测 / checkpoint）是 PR-4 范围，PR-2 仅单封 resync
- 完成时 pytest ≥ 338 passed，pip install -e ".[cli]" + mailagent --help 通过
- docs/cli-schema/ 10 个 schema MVP 落位

关键决策点（schema 取舍、命名冲突、API 契约变化）用 AskUserQuestion 对齐。
```

---

## 9. PR-2 之后的 roadmap

| PR | 范围 | 预估 |
|---|---|---|
| **PR-3** | attachment / llm / notion / calendar / debug 子命令 + 对应 schema | 2-3 天 |
| **PR-4** | backfill / project-progress / init batch 命令 + 长任务契约（PM2 检测 / checkpoint / `--range` / `--max-failures`）+ R-06 v4_rollout 监控持久化 | 3 天 |
| **PR-5** | scripts/* 大扫除（git mv + thin wrappers）+ docs 全文 update | 1-2 天 |
| **PR-6** | deprecation cleanup（删 thin wrappers）| 0.5 天 |

详见 RFC §10。

---

> 本 handoff 由 RFC v2 §4 / §5 / §6 / §7 + PR-2 §10 派生。PR-1 已 ship（8 commits, 323 passed, 0 failed）。等 PR-2 ship + merge 后，PR-3 handoff 另开。
