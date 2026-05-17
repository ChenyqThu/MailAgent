# Agent CLI 设计 RFC（mailagent）

> **状态**: Draft v2（吸纳 Codex GPT-5.5 highest-effort review）
> **作者**: Claude Code（基于 Phase 4 backend review 落地）
> **关联文档**:
> - 输入: [`phase4-handoff-backend-review-and-agent-cli.md`](./phase4-handoff-backend-review-and-agent-cli.md), [`backend-review-2026-05.md`](./backend-review-2026-05.md)
> - 输出（未来）: PR 拆分（见 §10）
>
> **v1 → v2 主要变更**（详见 §14 Changelog）:
> - 修正 R-02 / R-03 / R-07 漏方案化（v1 把 R-03 标签错给了 D3 决策）
> - 补 `mailagent calendar recurring {discover, replay}` 覆盖 `replay_recurring_invite.py`
> - 补 `mailagent init` 7 个 actions（fix-properties / fix-critical / update-parents / sync-new 等）
> - 补 `mailagent llm compare-paths`、`admin cleanup *`、`notion {page-orphans, file-link-audit}`
> - `email resync-range` 合并成 `email resync --range`
> - `attachment download` 的 `-o` → `--dest`（避开全局 `--output` 冲突）
> - `-o json` 不再默认 NDJSON；NDJSON 独立 `--output ndjson` / `--stream`
> - 写命令默认要求 API key；开发模式显式 `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true`
> - 配置加载改 `load_config(...)` 工厂，不依赖 module-level singleton
> - JSON Schema 补真规范（`docs/cli-schema/`、字段拆数字、$schema、required、error / partial-failure / NDJSON meta）
> - v4 灰度指标改持久化（SQLite 表 or stats_reporter），不依赖 CLI 短进程内存
> - scripts 数量 47 → **44**（实数），迁移表重排：cleanup_*.py 进 `admin cleanup`，replay_recurring 进 `calendar recurring`，compare_llm 进 `llm compare-paths`
> - 命名 `v4_grayscale` → `v4_rollout`
> - 长任务契约补：SIGINT 二次强退、退出码细分（completed / aborted / max-failures）、PM2 running 检测、checkpoint resume
> - Typer 版本 pin `>=0.12,<0.14`
> - Python 版本口径：package `>=3.9`，CLI tested on 3.11+
>
> **重要**: 本 RFC 不实现代码，仅产出完整设计 + 命令 spec + PR 拆分。落地由后续 session 推进。

---

## 1. TL;DR

把现有散落在 `scripts/*.py` 中的 ~9 个核心 CLI + Python API（`EmailRepository / NotionSync / SyncStore / LLMRunner / EventHandlers`）整合为一个**单入口、resource-first、agent-friendly** 的命令行工具 `mailagent`，参考 gh / kubectl / aws-cli 范式。

**MVP 范围**（PR-2 / PR-3）：
- `mailagent email {get,list,body,search,resync,delete}`
- `mailagent attachment {list,download,derive}`
- `mailagent llm {run,selftest,retry-failed}`
- `mailagent admin {stats,health,dead-letter}`
- 全局 `--output {text,json,yaml}`、`--quiet`、`--verbose`、`--db-path`、`--api-key`

**完整范围**（PR-4）：再加 `backfill / notion / project-progress / init / calendar / debug` 共 9 个 resource。

**与 scripts/* 的关系**：CLI 上线后逐步 deprecate 顶层 `scripts/*.py` 中的核心 CLI（迁移表见 §9）。一次性迁移脚本进 `scripts/archive/`，dev/debug 脚本进 `scripts/dev/`，shell helper 保留。

**实现栈**：Python 3.11+ + `typer` + `pyproject.toml console_scripts` entrypoint。`pip install -e .` 后即可全局 `mailagent` 命令。

**不在 RFC scope**：
- Server mode (`mailagent serve` HTTP API)：用户已明确推迟到独立 RFC
- Phase 5 Web / Electron 前端
- Webhook-server（远程 VPS FastAPI，独立项目）

---

## 2. 设计原则

按重要性排序：

1. **Agent-first**：所有命令 `--output json` 输出 stable schema，每个字段在 docs 里有明确语义。stderr 仅 1 行 timing/counts（`--quiet` 抑制）。
2. **资源-动作 一致**：`<noun> <verb> [<id>] [flags]` 始终成立。tab 补全友好，agent autocomplete 可枚举。
3. **现有 Python API 是 ground truth**：CLI 是 wrapper，不重写业务逻辑。每个命令只做：参数解析 → 调 API → 格式化输出。
4. **可观测**：每条命令默认 stderr 输出执行摘要（duration、行数等），便于 agent 检查执行情况。
5. **可中断**：长任务（backfill / resync 区间）支持 `--max-failures` 熔断 + `--progress-every` 进度回报。
6. **配置一致**：默认读 `.env`（与服务一致）；`--db-path` / `--api-key` 等覆盖；`MAILAGENT_*` 环境变量优先级最高。
7. **不破坏现状**：CLI 与 `scripts/*` 共存一段时间，scripts 移走前老脚本必须仍能跑（pm2 / docs 不立即改）。

---

## 3. 前置 refactor（来自 backend review §6）

CLI 落地依赖以下 **五项** refactor，**作为 PR-1 先行**（v2 补 R-02 / R-03 / R-07，v1 漏方案化）：

| § | 改动 | backend review 编号 | 测试 / 文档影响 |
|---|---|---|---|
| 3.1 | NotionSync strict DI | R-01 | 修 I-01；CLI 注入点 |
| 3.2 | `EmailRepository.get_email_full` | **D3 推荐**（v1 错标 R-03，已修正） | 新增 dataclass + 单测 |
| 3.3 | AttachmentStore 绝对路径 + 兼容老 local_path | R-04 / D4 | CLI cwd 解除 |
| 3.4 | `_handle_thread_relations` 切 SQLite SSoT | R-02 | thread query 走 SQLite 优先 + Notion fallback |
| 3.5 | `fetched` 状态决断（删 + 同步 docs） | R-03 + R-07 | 死代码清理 + CLAUDE.md / schema 注释 update |

### 3.1 NotionSync strict DI（R-01）

```python
# 改造后接口
class NotionSync:
    def __init__(
        self,
        *,
        email_repo: EmailRepository,
        sync_store: SyncStore,
        client: Optional[NotionClient] = None,
    ): ...

    # 删除:
    # - _ensure_sqlite_resources()
    # - _repo / _sync_store 的 Optional / lazy 状态
```

**影响调用点**：
- `src/mail/new_watcher.py:119` → 改 `NotionSync(email_repo=self.email_repo, sync_store=self.sync_store)`
- `src/mail/reverse_sync.py:40` → 同上（NotionToMailSync.__init__ 内）
- `scripts/resync_notion.py` → CLI 起作用前的 transitional 脚本，PR-2 改成走新 API
- `tests/notion/test_create_from_sqlite.py` 各 fixture → 显式注入

**单进程内 EmailRepository / SyncStore / AttachmentStore 实例数变化**：3 → 1（NewWatcher 持有，传给 NotionSync + LLMRunner）。

**配套修复**：`tests/notion/test_create_from_sqlite.py::test_disabled_by_default`（I-01）的 monkeypatch 缺失也在这次一起 fix。

### 3.2 EmailRepository.get_email_full（D3 推荐 —— v1 错标 R-03 已修正）

新增统一聚合接口：

```python
# src/repository/email_repository.py 新增
@dataclass
class EmailMetadataRecord:
    """email_metadata 行的 dataclass 投影（替代 Dict 出口）。"""
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
    """get_email_full 的返回组合。"""
    internal_id: int
    metadata: EmailMetadataRecord
    body: Optional[EmailBodyRecord]
    attachments: list[AttachmentRecord]


class EmailRepository:
    # 现有方法保留
    
    def get_metadata(self, internal_id: int) -> Optional[EmailMetadataRecord]:
        """新增：单独取 metadata（不带 body / attachments）"""
        ...
    
    def get_email_full(self, internal_id: int) -> Optional[EmailFull]:
        """新增：一次查全 metadata + body + attachments"""
        meta = self.get_metadata(internal_id)
        if not meta:
            return None
        return EmailFull(
            internal_id=internal_id,
            metadata=meta,
            body=self.get_body(internal_id),
            attachments=self.get_attachments(internal_id),
        )
```

**SyncStore 不删**：旧 `sync_store.get(internal_id)` 仍保留（pending email 处理 / retry queue 等内部路径），但 CLI 走 `repo.get_email_full`。

**测试**：补 `tests/repository/test_email_repository.py::TestGetEmailFull` 覆盖 happy / missing metadata / missing body / 含 derived attachments。

### 3.3 AttachmentStore 绝对路径（R-04/D4）

```python
class AttachmentStore:
    def __init__(self, base_dir: str | Path = "data/attachments"):
        # 改：构造时 resolve 绝对路径
        self.base_dir = Path(base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)
    
    def relative_path(self, internal_id, filename):
        # 改：返回 base_dir 相对项目根的形式（向后兼容 SQLite 已存路径）
        safe = self.sanitize_filename(filename)
        return str(Path(self.base_dir.name) / str(internal_id) / safe)  # e.g. "attachments/41457/foo.pdf"
        # 注：之前是 "data/attachments/41457/foo.pdf"，这次改成 "attachments/..."
        # 需要 migration（见下）
    
    def read(self, local_path):
        p = Path(local_path)
        if p.is_absolute():
            return p.read_bytes()
        # 关键改动：以 base_dir.parent 为锚而非 cwd
        # base_dir = ".../MailAgent/data/attachments"，parent = ".../MailAgent/data"
        # local_path = "attachments/53675/file.pdf"
        return (self.base_dir.parent / p).read_bytes()
```

**Migration**（最低代价路径）：
- 不动 SQLite 已存的 `local_path`（仍是 `"data/attachments/..."` 形式）
- `AttachmentStore.read` 兼容两种相对形式：以 base_dir.parent 为锚 (`data/attachments/...`) 或新形式 (`attachments/...`)
- 新写入用绝对路径（`Path.resolve()`）

或者**激进**：写 `scripts/archive/migrate_attachment_paths.py` 把所有 `local_path` 改成绝对，CLI 之后默认绝对。

**RFC 推荐**：兼容路径（不 migration）。CLI 在 read 时智能解析。详见 PR-1 实现说明。

### 3.4 `_handle_thread_relations` 切 SQLite SSoT（R-02）

**v2 新增**。Phase 4 灰度切 true 后，`_handle_thread_relations` 仍走 Notion API 查兄弟邮件（`notion/sync.py:1322` → `_find_all_thread_members_with_date`），错过 SSoT 收益且让 thread relations 仍是 Notion 出/入双向。

**改造方案**：

```python
# src/repository/email_repository.py 新增
@dataclass
class ThreadMember:
    internal_id: int
    page_id: Optional[str]           # email_metadata.notion_page_id
    date_received: Optional[str]
    is_synced: bool                  # sync_status == 'synced'


class EmailRepository:
    def get_thread_members(
        self,
        thread_id: str,
        *,
        exclude_internal_id: Optional[int] = None,
        synced_only: bool = True,
    ) -> list[ThreadMember]:
        """新增：从 SQLite 查同 thread_id 的兄弟邮件。
        
        与 sync_store.get_all_emails_by_thread_id 的区别:
            - 返回 dataclass 而非 dict
            - 用 internal_id 排除（而非 message_id），与 caller 语义一致
            - default synced_only=True 因为 _handle_thread_relations
              只关心已上 Notion 的邮件（要写 relation 必须有 page_id）
        """
        ...
```

**`_handle_thread_relations` 改造**：

```python
async def _handle_thread_relations(self, page_id: str, email: Email):
    members = self._email_repo.get_thread_members(
        thread_id=email.thread_id,
        exclude_internal_id=email.internal_id,
        synced_only=True,
    )
    if not members:
        # SQLite 没找到 → 灰度期可选 fallback Notion 查询
        if app_config.thread_relations_fallback_to_notion:
            members = await self._find_all_thread_members_with_date_via_notion(...)
        else:
            return
    # 与 v1 同的日期比较 + sub-item 设置逻辑
    ...
```

**配置开关**:

```python
# src/config.py 新增
thread_relations_fallback_to_notion: bool = Field(
    default=True, env="THREAD_RELATIONS_FALLBACK_TO_NOTION",
    description=(
        "_handle_thread_relations 在 SQLite 查不到 thread members 时是否 fallback "
        "Notion API（v4 R-02 灰度期开关；historic backfill 完成后可关）"
    ),
)
```

**收益**:
- 每封 thread 邮件少 1 次 Notion query（同步加速 + API quota）
- 反向同步 / 离线重传场景下不再依赖 Notion 可达
- 真正完成 Phase 4 "Notion 是镜像不是数据源"目标

**测试**:
- `tests/repository/test_email_repository.py::TestGetThreadMembers`
- `tests/notion/test_thread_relations_sqlite_first.py`（mock repo + notion fallback 双场景）

**风险**：中。如果某些历史邮件在 SQLite 中 sync_status='synced' 但实际 notion_page_id 失效（用户手 archive），SQLite 拿到的 page_id 是死链。PR-1 加 `_handle_thread_relations` 在 update_sub_items 前对 page_id 做 `check_page_exists` 健康检查；失败的 member 跳过。

### 3.5 `fetched` 状态决断 —— **删**（R-03 + R-07）

**v2 新增**。Backend review I-02 / R-03：`fetched` 在 `sync_store.py:81`（TypedDict comment）/ `sync_store.py:1302`（docstring）/ `architecture_v4_sqlite_ssot.md` / `CLAUDE.md` 状态流转图都声明了，但**代码无任何 `mark_fetched()` 写入路径**。是死代码。

**决断**：删（v2 选项 A，最小成本）。状态机改为 6 状态：

```
pending → fetch_failed → ... → synced / failed / dead_letter / skipped
       └─→ synced
       └─→ failed → ... → synced / dead_letter
       └─→ skipped
```

**PR-1 同步改动**:
1. `src/mail/sync_store.py:81` TypedDict EmailMetadata 注释删 `fetched`
2. `src/mail/sync_store.py:1302` `get_emails_by_status` docstring 删 `fetched`
3. `docs/architecture_v4_sqlite_ssot.md` 状态流转段更新（**R-07**）
4. `CLAUDE.md` "状态流转"段更新（**R-07**）
5. `docs/backend-review-2026-05.md` 注 fix 完成
6. CLI `--status` 选项枚举去掉 `fetched`：`{pending,fetch_failed,synced,failed,skipped,dead_letter}`
7. `mailagent admin stats --section dead-letter` 输出 schema 不含 fetched 字段

**测试**:
- `tests/mail/test_sync_store_status_machine.py`（新增）：assert `get_emails_by_status('fetched')` 永远返回 `[]`（因为没人写入），同时 docstring 不再列 fetched

**风险**：极低。pure 文档 + 注释清理；状态机实际行为不变（fetched 本来就没人写）。

### 3.6 测试与文档前置清单（PR-1 自含）

PR-1 完成时必须同时满足：

| 项 | 说明 |
|---|---|
| `tests/notion/test_create_from_sqlite.py::test_disabled_by_default` 加 monkeypatch | 修 I-01 |
| `tests/repository/test_email_repository.py::TestGetEmailFull` 新增 | 测 D3 |
| `tests/repository/test_email_repository.py::TestGetThreadMembers` 新增 | 测 R-02 |
| `tests/notion/test_thread_relations_sqlite_first.py` 新增 | 测 R-02 e2e |
| `tests/mail/test_sync_store_status_machine.py` 新增 | 测 R-03 |
| `tests/repository/test_attachment_store.py::TestAbsolutePath` 新增 | 测 R-04 |
| `architecture_v4_sqlite_ssot.md` 状态机段 update | R-07 |
| `CLAUDE.md` 状态机段 update | R-07 |
| `backend-review-2026-05.md` I-02 / R-02 / R-03 标 fixed | 历史记录 |
| 全量 pytest 通过：≥ 296 passed（v1 的 295 + R-02 + R-03 + R-04 + EmailFull 等新增测试） | 回归 |

---

## 4. 命令树全量 spec

### 4.1 顶层

```
mailagent <resource> <action> [<id>] [flags...]

resources:
  email              邮件 CRUD + 搜索 + 重传
  attachment         附件 list / download / derive
  llm                LLM 处理（AI 字段）
  backfill           历史回填工具
  notion             Notion 直接操作（flag update / orphan）
  project-progress   项目周报同步外挂
  admin              统计 / 健康检查 / 死信
  init               初始化同步（取代 initial_sync.py）
  calendar           日历相关（会议展开）
  debug              调试工具

global flags:
  -o, --output {text,json,yaml}    输出格式（默认 text）
  -q, --quiet                      抑制 stderr 摘要
  -v, --verbose                    DEBUG 级日志
      --db-path PATH               覆盖 sync_store.db 路径
      --api-key TOKEN              覆盖 MAILAGENT_CLI_API_KEY
      --config PATH                覆盖 .env 路径
      --no-color                   强制无色（agent 默认无色）
      --version                    print version 退出
  -h, --help                       命令帮助
```

### 4.2 email

```
mailagent email get <internal_id> [--include {body,attachments,all}]

  返回 metadata 默认；--include 选择性附加。
  无 body 时 body=null；无 attachments 时 attachments=[]。

  Examples:
    $ mailagent email get 53675
    $ mailagent email get 53675 --include all -o json
    $ mailagent email get 53675 --include body --output json | jq '.body.markdown'

mailagent email list [flags]

  flags:
    --mailbox {收件箱,发件箱}
    --status {pending,fetch_failed,synced,failed,skipped,dead_letter}
    --since YYYY-MM-DD              按 date_received 过滤
    --until YYYY-MM-DD
    --from EMAIL                    sender 精确 / 子串
    --subject SUBSTR
    --is-read {true,false}
    --is-flagged {true,false}
    --has-notion {true,false}
    --limit N (default 50, max 500)
    --offset N (default 0)
    --source {syncstore,mail}       默认 syncstore（已同步邮件）；mail = Mail.app 全量

  默认 stdout 表格输出（internal_id / subject / sender / date / status）。
  --output json 输出 ndjson 流（一行一邮件，便于 agent 边读边处理）。

  Examples:
    $ mailagent email list --mailbox 收件箱 --status synced --limit 10
    $ mailagent email list --since 2026-05-01 --has-notion true -o json > recent.ndjson

mailagent email body <internal_id> [--format {markdown,html,raw}]

  返回邮件正文。默认 markdown（短）；html 为原始 HTML；raw 为
  raw_mime_sha256（仅哈希，不带原 MIME）。

  Examples:
    $ mailagent email body 53675                          # markdown，stdout
    $ mailagent email body 53675 --format html > out.html
    $ mailagent email body 53675 -o json                  # {format, content, size_bytes}

mailagent email search <query> [flags]

  FTS5 全文搜索（基于 v4 email_body_fts）。

  flags:
    --mailbox X
    --since YYYY-MM-DD
    --until YYYY-MM-DD
    --limit N (default 50, max 200)
    --no-snippet                    隐藏 snippet 高亮，仅返回 metadata

  query 语法：短语 "..."、AND/OR/NOT、前缀 *、邻近 NEAR(a,b,5)。
  中文用前缀通配 产品* 命中（unicode61 tokenizer 限制，见 CLAUDE.md）。

  Examples:
    $ mailagent email search "redis AND timeout"
    $ mailagent email search "meeting NOT canceled" --mailbox 收件箱 --limit 20
    $ mailagent email search '产品*' --since 2026-05-01 -o json

mailagent email resync [<internal_id> | --range LO-HI | --ids LIST] [flags]

  基于 SQLite SSoT 重传邮件到 Notion（v4 Phase 4）。单封 / 范围 / 列表统一这一个命令。

  target（三选一）:
    <internal_id>                   位置参数：单封
    --range LO-HI                   闭区间，含端点。例: --range 53000-53100
    --ids LIST                      逗号分隔。例: --ids 53674,53675,53677

  flags:
    --replace-existing              archive 老页 → 建新
    --dry-run                       只打 plan，不写 Notion
    --no-parent                     跳过 thread relations 重建（diff 验证用）
    --max-failures N (default 5)    熔断阈值（仅 batch 模式有效）
    --progress-every N (default 10) stderr 进度间隔
    --resume-from N                 batch 从 internal_id >= N 续跑（checkpoint）

  对应 scripts/resync_notion.py（保留 thin wrapper，会标 deprecation）。

  Examples:
    $ mailagent email resync 53675 --dry-run                        # 单封
    $ mailagent email resync 53675 --replace-existing               # 单封强制
    $ mailagent email resync --range 53000-53100 --replace-existing # 范围
    $ mailagent email resync --ids 53674,53675,53677 --dry-run      # 列表
    $ mailagent email resync --range 53000-53100 --resume-from 53050  # checkpoint 续跑

mailagent email delete <internal_id> [--yes]

  CASCADE 删除该邮件（metadata + body + attachments + 本地文件）。
  Notion 上不动（如需 archive 走 mailagent notion archive）。

  默认要交互确认；--yes 跳过。

  Examples:
    $ mailagent email delete 53675 --yes
```

### 4.3 attachment

```
mailagent attachment list <internal_id> [-o {text,json}]

  列出该邮件所有附件（含 derived），按 inline → normal 排序。

  Examples:
    $ mailagent attachment list 53675

mailagent attachment download <attachment_id> [--dest PATH]

  下载附件到本地。默认 stdout（二进制）；--dest 指定写文件。
  **v2 改动**：把 `-o/--output` 让给全局 flag，下载用 `--dest`（避免与 `--output json` 冲突）。

  Examples:
    $ mailagent attachment download 1024 --dest ./out.pdf
    $ mailagent attachment download 1024 > /tmp/file.bin

mailagent attachment derive <internal_id> [--dry-run]      # alias，主入口移到 backfill

  v2 改动：保留作 alias，主入口建议 `mailagent backfill derivatives --internal-id N`。
  原因：derive 的对象其实是 email 的附件集合，归 backfill resource 更直观。

  Examples:
    $ mailagent attachment derive 53677 --dry-run

mailagent attachment cleanup-orphans [--dry-run --yes]

  扫 data/attachments/ 下没有对应 email_metadata 行的目录。
  对应未来 T-06 cleanup CLI。
```

### 4.4 llm

```
mailagent llm run <internal_id> [flags]

  对单封邮件跑 LLM 分类填 Notion AI 字段。

  flags:
    --dry-run                       不写 Notion，只打 LLM 输出
    --force                         即使 llm_processing.status='success' 也重跑
    --no-overwrite                  保留 Notion 中已手改的非空字段
    --range LO-HI                   批量 run（替代单封 internal_id）
    --internal-ids LIST             逗号列表批量

  对应 scripts/run_llm_on_email.py。

  Examples:
    $ mailagent llm run 53675 --dry-run
    $ mailagent llm run --range 51000-51100 --force --no-overwrite

mailagent llm selftest

  Gateway 健康检查（不烧 token，不写 Notion）。

  Examples:
    $ mailagent llm selftest
    $ mailagent llm selftest -o json

mailagent llm retry-failed [--limit N]

  手动跑 LLM retry queue（指数退避到期的失败邮件）。
  默认 limit 10。

mailagent llm stats [--days N]

  llm_processing 表统计（status 分布 + cost / cache 命中率）。

  Examples:
    $ mailagent llm stats --days 7

mailagent llm compare-paths [--count N --internal-ids LIST --dry-run]

  v2 新增。Phase 2 v4 rollout 质量闸：对 N 封邮件分别走"SQLite markdown 路径"
  vs "in-memory 正则路径"喂 LLM，diff AILabels 输出，量化两条路径分类一致率。
  对应 scripts/compare_llm_path.py（升级为一等命令，至少保留到 SQLite 路径稳定一个 release window）。

  flags:
    --count N (default 20)          随机抽 N 封邮件对比
    --internal-ids LIST             指定邮件（覆盖 --count）
    --dry-run                       仅打印 plan
    --output {text,json}            json 输出每封 diff 详情

  Examples:
    $ mailagent llm compare-paths --count 50
    $ mailagent llm compare-paths --internal-ids 53674,53675 -o json
```

### 4.5 backfill

```
mailagent backfill body [flags]

  历史邮件正文双写到 SQLite。对应 scripts/backfill_email_body.py。

  flags:
    --since-date YYYY-MM-DD
    --until-date YYYY-MM-DD
    --mailbox {收件箱,发件箱}
    --internal-ids LIST
    --all                           全量（与上互斥）
    --limit N                       上限
    --force                         覆盖已 backfilled
    --dry-run
    --max-failures N (default 20)
    --progress-every N (default 10)

  Examples:
    $ mailagent backfill body --since-date 2026-03-01
    $ mailagent backfill body --internal-ids 53000-53100 --dry-run

mailagent backfill derivatives [flags]

  扫所有 email_attachment 补漏 Office 衍生。对应 scripts/backfill_derivatives.py。

  flags:
    --internal-id N                 仅补单封
    --dry-run
    --max-failures N
    --progress-every N

  Examples:
    $ mailagent backfill derivatives --dry-run
    $ mailagent backfill derivatives
```

### 4.6 notion

```
mailagent notion resync <internal_id> [...]
  
  等价于 `mailagent email resync`；提供 notion 命名空间下的 alias，
  便于"Notion 方向"思考模型的用户。建议**默认走 email resync**。

mailagent notion update-flag <internal_id> [flags]

  手动更新 Notion 邮件页面的 flag / processing status。

  flags:
    --is-read {true,false}
    --is-flagged {true,false}
    --processing-status {AI Reviewed,已同步,已完成,草稿已创建}

mailagent notion page-orphans [--dry-run --limit N]

  v2 改名 + 拆分。扫 Notion 邮件库里**有 page、SQLite 无 metadata**的页面
  （历史用户手动建的 / migration 残留）。
  之前 v1 的 "list-orphans" 命名含混 —— 拆成三类（见下）：

  Examples:
    $ mailagent notion page-orphans --dry-run

mailagent notion file-link-audit [--internal-id N --dry-run]

  v2 新增。扫 email_attachment.notion_file_id：
    - NULL but Notion page has file blocks → 上传未回写
    - NOT NULL but Notion file_upload 已过期 → 死链
  独立于 attachment cleanup-orphans（后者是磁盘 orphan，本命令是 Notion side audit）。

  Examples:
    $ mailagent notion file-link-audit
    $ mailagent notion file-link-audit --internal-id 53675

mailagent notion archive <page_id> [--yes]

  archive 指定 Notion 页（移到 Trash）。
```

### 4.7 project-progress

```
mailagent project-progress sync [flags]

  对应 scripts/sync_project_progress.py。

  flags:
    --internal-id N
    --all-history
    --limit N (默认 10)
    --sheets {ongoing,shipped,suspended,all}
    --dry-run
    --force
    --backfill-project-start
    --first-migration-dry-run

  Examples:
    $ mailagent project-progress sync --internal-id 52258
    $ mailagent project-progress sync --all-history --limit 10 --dry-run
```

### 4.8 admin

```
mailagent admin stats [flags]

  汇总服务运行状态。

  flags:
    --section {watcher,handlers,llm,reverse,all}
    -o json                         结构化输出

  Examples:
    $ mailagent admin stats
    $ mailagent admin stats --section watcher -o json

mailagent admin health

  跑 health_check（SyncStore 可访问 / Mail.app SQLite 可访问 / Notion API 通）。
  exit 0 健康，1 不健康。

mailagent admin db-version

  打印 sync_store.db 当前 db_version 与各表行数。

mailagent admin dead-letter list [--limit N]

  列出 dead_letter 状态邮件。

mailagent admin dead-letter retry <internal_id>

  把 dead_letter 邮件重置为 pending（retry_count=0），下次 poll 重跑。

mailagent admin cleanup-deadletter [--older-than N --yes]

  清理 dead_letter 超过 N 天的记录（默认 30 天）。

mailagent admin cleanup syncstore [--dry-run --yes]

  v2 新增。对应 scripts/cleanup_syncstore.py（已 deprecated 老路径）。
  扫 SQLite 中"应删未删"的记录（如 deleted from Mail.app 但 SyncStore 残留）。
  默认 dry-run；--yes 提交。

mailagent admin cleanup duplicates [--dry-run --yes]

  v2 新增。对应 scripts/cleanup_duplicate_message_ids.py。
  扫 message_id 重复但 internal_id 不同的记录（Outlook 同步异常 / 重发邮件）。

mailagent admin repair-parents [--dry-run --thread-id ID --yes]

  v2 新增。对应 scripts/cleanup_notion_db.py 的 parent-relation 修复路径。
  扫 Notion 邮件页 Parent Item 关系断链 + 重建（基于 SQLite SSoT 的 thread_id 索引）。

# v2 反模式提示：上面 3 个 cleanup 命令都是危险操作。
# 默认 dry-run、强制要求 --yes、要求 MAILAGENT_CLI_API_KEY（见 §5.3）。
```

### 4.9 init

```
mailagent init fetch-cache [--inbox-count N --sent-count M]

  从 Mail.app 拉取邮件元数据到 SyncStore（cache 预热）。

mailagent init analyze [--input PATH --report-out PATH --skip-fetch]

  分析 SyncStore vs Notion 差异 + Parent Item 完整性。
  --input：从前次 --report-out 的 JSON 加载分析报告，跳过重新计算
  --report-out：保存本次分析报告到 JSON
  --skip-fetch：不重新从 Mail.app 拉，仅对比现有数据

mailagent init fix-properties [--yes --report-in PATH]

  v2 新增。对应 scripts/initial_sync.py --action fix-properties。
  修复 date / thread_id 等 properties 在 SQLite vs Notion 不一致的邮件。

mailagent init fix-critical [--yes --report-in PATH]

  v2 新增。对应 --action fix-critical。
  重新同步 critical 字段（subject / sender / message_id）不一致的邮件。

mailagent init update-parents [--yes --report-in PATH]

  v2 新增。对应 --action update-all-parents。
  遍历验证并修复所有 Parent Item 关系（含线程头补同步）。

mailagent init sync-new [--yes]

  v2 新增。对应 --action sync-new。
  仅同步新邮件（SyncStore 已 cache 但 Notion 还没有的）。

mailagent init all [--yes --inbox-count N --sent-count M --report-out PATH]

  按顺序执行 fetch-cache → analyze → fix-properties → fix-critical
  → update-parents → sync-new。

  对应 scripts/initial_sync.py 的 7 个 --action 全集（v2 补全，v1 仅 4 个不完整）。
```

### 4.10 calendar

```
mailagent calendar expand [--horizon-weeks W --dry-run]

  手动触发周期会议 occurrence 滚动展开（main.py 中 _meeting_expansion_loop 的单次手动版）。

mailagent calendar recurring discover [flags]

  v2 新增。对应 scripts/replay_recurring_invite.py --discover-recurring。
  扫 Mail.app 中已有的周期会议邀请（iCal METHOD=REQUEST + RRULE），列出
  series_uid + master_dtstart 等 metadata，便于人工 audit / 决定哪些要 replay。

  flags:
    --since DATE                    起始日期（默认 SYNC_START_DATE）
    --discover-limit N (default 2000)  扫描的最大邮件数
    --output {text,json}

  Examples:
    $ mailagent calendar recurring discover --since 2026-01-01

mailagent calendar recurring replay [<internal_id> | --ids LIST] [flags]

  v2 新增。对应 scripts/replay_recurring_invite.py 的 replay 路径。
  对指定的周期会议邀请重跑 meeting_sync.process_email（修复历史 mis-sync 的
  recurring series；如新 occurrence 没展开、master/override 关系错乱等）。

  flags:
    --internal-id N                 单封
    --ids LIST                      逗号分隔批量
    --dry-run

  Examples:
    $ mailagent calendar recurring replay --internal-id 53120
    $ mailagent calendar recurring replay --ids 53120,53121
```

### 4.11 debug

```
mailagent debug email-source <internal_id> [--output PATH]

  打印 / 保存邮件 raw MIME 源码（从 AppleScript 重抽）。
  对应 scripts/export_email_content.py。

mailagent debug mail-structure

  列出 Mail.app 所有 mailbox 名 + URL prefix（用于配置 SYNC_MAILBOXES）。
  对应 scripts/debug_mail_structure.py。

mailagent debug inline-images <internal_id>

  分析单封邮件的 inline images / cid 引用。
  对应 scripts/check_inline_images.py。

mailagent debug applescript-fetch <internal_id> [--mailbox X]

  仅跑 AppleScript fetch_email_content_by_id，打印结果（绕过 SQLite SSoT 路径）。

mailagent debug notion-page <page_id>

  Notion API 拉取并打印指定 page 的 properties。
```

---

## 5. 通用约定

### 5.1 输出格式

#### 5.1.1 text（默认）

人类可读，颜色化（除非 `--no-color`），表格用 `rich` 或纯 ASCII。stderr 默认输出 1 行执行摘要：

```
$ mailagent email list --limit 10
INTERNAL_ID  SUBJECT                                  SENDER             DATE        STATUS
53675        RE: Design Hub与Omada Store联动...        a@example.com      2026-05-15  synced
53676        Hi Email dual-write test                 b@example.com      2026-05-16  synced
...
(stderr): 10 emails in 23ms
```

#### 5.1.2 json（**v2 改**：始终是 wrapper object，不再默认 NDJSON）

每条命令的 JSON 输出 schema **稳定**，作为 agent 调用契约（参见 §7）：

```json
{
  "status": "success",
  "schema_version": 1,
  "data": [ ... ],                                    // list / search 类: array
  "meta": { "duration_ms": 23, "count": 10, "total": 1543, "limit": 50, "offset": 0 }
}
```

单条返回：

```json
{
  "status": "success",
  "schema_version": 1,
  "data": { "internal_id": 53675, ... },              // get / body 类: object
  "meta": { "duration_ms": 8 }
}
```

错误：

```json
{
  "status": "error",
  "schema_version": 1,
  "error": {
    "code": "E_NOT_FOUND",
    "message": "Email with internal_id=99999 not found",
    "hint": "Use 'mailagent email list' to find available IDs"
  },
  "meta": { "duration_ms": 5 }
}
```

部分失败（batch 命令）：

```json
{
  "status": "partial_failure",
  "schema_version": 1,
  "data": {
    "succeeded": [...],
    "failed": [{"internal_id": 53675, "error": {"code": "...", "message": "..."}}],
    "summary": {"total": 100, "succeeded": 87, "failed": 13}
  },
  "meta": { "duration_ms": 145320, "aborted_by": null }
}
```

stderr 仅在 `--verbose` 时输出 debug；stdout 是纯 JSON（agent 可 `jq` 直接消费）。
与 AWS CLI / kubectl / gh 的 `-o json` 默认行为对齐（始终 wrapper object）。

#### 5.1.3 yaml

同 JSON 内容，YAML 序列化。

#### 5.1.4 ndjson / --stream（**v2 改**：从 json 默认拆出，独立选项）

对 `mailagent email list / search / resync (batch)` 等大结果集，**显式**用 `--output ndjson` 或 `--stream` 走 NDJSON：

```
$ mailagent email list --output ndjson
{"internal_id": 53675, "subject": "...", ...}
{"internal_id": 53676, ...}
{"_meta": {"total": 1543, "limit": 50, "offset": 0, "duration_ms": 87}}    # 总是最后一行
```

**NDJSON 规则**:
- 每行一个独立 JSON object，便于 `jq -c .` 流式处理
- 最后一行强制 `_meta` 元数据（含 total / duration_ms / aborted 等）
- 错误也是一行（含 `error.code` / `error.message`），不中断流
- batch 命令的 partial-failure 在最后 `_meta.failed=N`

`--output json` **不再**默认 NDJSON（v1 设计偏离行业 standard 已修正）。

### 5.2 退出码（**v2 扩**：细分 batch / 长任务退出码）

| 码 | 含义 | 触发 |
|---|---|---|
| 0 | 成功 | 业务正常（含 partial_failure 但全部 succeeded） |
| 1 | 业务失败 | not found / Notion API 错 / dry-run 检测到不一致（非 batch 模式） |
| 2 | 参数错 | typer 自动 |
| 4 | 认证失败 | --api-key 校验不通过 / 写命令缺 token 且无 unsafe-flag |
| 5 | 数据不一致 | DB schema mismatch / `db_version != 5/6` |
| 6 | partial_failure | batch 命令部分成功部分失败 |
| 7 | aborted | SIGINT/SIGTERM 主动退出 |
| 8 | max-failures | 长任务连续失败超 `--max-failures` 熔断 |
| 9 | pm2 conflict | 写命令检测到 PM2 mail-sync 正在跑 |
| 130 | SIGINT 二次强退 | 用户在 abort summary 阶段再按 Ctrl-C |

### 5.3 认证（**v2 修**：默认要 token，开发模式显式 unsafe）

| 操作类型 | 是否要 API key |
|---|---|
| 读类（email get/list/body/search, attachment list/download, admin stats/health/db-version, llm stats, debug *）| **否**（本机访问 SQLite，无需鉴权）|
| 写类（email resync/delete, llm run/retry-failed/compare-paths, backfill *, notion *, admin dead-letter retry/cleanup *, init *, project-progress sync, calendar recurring replay）| **是**（要求 `MAILAGENT_CLI_API_KEY` 或 `--api-key`）|

校验机制：服务端配 `MAILAGENT_CLI_API_KEY` 后写命令必须提供；CLI 用 `hmac.compare_digest` 比对。不上 OAuth、不做 RBAC、不区分用户。

**v2 修正**：v1 skeleton 写"`expected token` 为空就放行"是反模式 —— 容易让"忘配"等同于"无防护"。v2 改为：

```python
# src/cli/auth.py
def require_auth(ctx):
    expected = global_config.mailagent_cli_api_key
    provided = ctx.api_key
    
    if not expected:
        # 服务端未配 → 默认拒绝写操作
        if not os.environ.get("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES") == "true":
            raise CliAuthError(
                "MAILAGENT_CLI_API_KEY not configured. "
                "Set it or export MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true to allow."
            )
        return  # 显式 opt-in 才放行
    
    if not provided or not hmac.compare_digest(expected, provided):
        raise CliAuthError("Invalid or missing API key")
```

**破坏性命令**（`email delete` / `admin cleanup *` / `notion archive`）额外要求：
- `--yes` 跳过 prompt（agent 调用必须显式传）
- 部分场景再叠加 `--confirm <internal_id>` 二次确认（防 wrong target）

**为什么这样设计**：CLI 调用者 = 拥有本机 sudo / shell 的用户。鉴权目的不是防本机其他用户（macOS FDA 已经把 SQLite 锁了），而是**防 agent / 第三方 process / 误粘贴命令** 错启动写命令。"默认拒绝 + 显式 opt-in"比"默认放行"安全得多。

环境变量优先级：
```
--api-key  >  $MAILAGENT_CLI_API_KEY  >  .env 里的 MAILAGENT_CLI_API_KEY
```

`MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` 仅 dev 环境用，**不应进 .env**（防 leak）。

### 5.4 配置（**v2 改**：显式 factory，不依赖 module-level singleton）

CLI 启动时通过 `load_config(config_path, env, flags)` factory 按顺序加载：
1. `~/.config/mailagent/config.toml`（用户级，可选）
2. `<project>/.env`（pydantic Config，**通过 factory 加载，不是 import-time singleton**）
3. `--config PATH` 指定的文件
4. `MAILAGENT_*` 环境变量
5. 命令行 flag（`--db-path` 等）

后者覆盖前者。`mailagent --config x.toml email get 53675` 用 `x.toml` 中的 db_path 而非 `.env`。

**v2 修正（实现细节）**：v1 skeleton 写 `from src.config import config as global_config` 是反模式 —— pydantic Settings 在 import 时立即加载 `.env`，CLI 后续的 `--config` flag 无法覆盖。**正确实现**：

```python
# src/cli/config.py（CLI 专用 factory）
def load_cli_config(
    config_path: Optional[str] = None,
    env_overrides: Optional[dict] = None,
    flag_overrides: Optional[dict] = None,
) -> Config:
    """Build a fresh Config instance respecting CLI flag/env/file priority."""
    env_file = config_path or ".env"
    # 用 pydantic-settings 的 customise_sources 显式注入 priority
    base = Config(_env_file=env_file)
    # 应用 MAILAGENT_* 环境覆盖
    for k, v in (env_overrides or {}).items():
        setattr(base, k, v)
    # 应用 CLI flag 覆盖
    for k, v in (flag_overrides or {}).items():
        if v is not None:
            setattr(base, k, v)
    return base


# src/cli/main.py @app.callback() 内：
@app.callback()
def main(
    ctx: typer.Context,
    output: str = ...,
    db_path: str = ...,
    api_key: str = ...,
    config: str = ...,
    ...
):
    cli_cfg = load_cli_config(
        config_path=config,
        env_overrides={...},
        flag_overrides={
            "sync_store_db_path": db_path,
            "mailagent_cli_api_key": api_key,
        },
    )
    ctx.obj = CliContext.from_config(cli_cfg, output=output, ...)
```

**注意**：`src/config.py:config = Config()` 全局 singleton 在 main.py / pm2 进程中**仍保留**（与服务一致），CLI 路径**不用**它。CLI 用 `load_cli_config()` 起独立实例，避免 `.env` import-time 锁死。

### 5.5 Help 体系

```
$ mailagent --help
Usage: mailagent [OPTIONS] COMMAND [ARGS]...

  MailAgent CLI - Agent-friendly interface to the MailAgent backend.

Commands:
  email             邮件 CRUD / 搜索 / 重传
  attachment        附件操作
  llm               LLM 处理（AI 字段填充）
  backfill          历史回填工具
  notion            Notion 直接操作
  project-progress  项目周报同步外挂
  admin             统计 / 健康 / 死信
  init              初始化同步
  calendar          日历相关
  debug             调试工具

Global Options:
  -o, --output TEXT  Output format: text / json / yaml (default: text)
  -q, --quiet        Suppress stderr summary
  -v, --verbose      DEBUG-level logging to stderr
  ...

Examples:
  mailagent email get 53675
  mailagent email search "redis timeout" --mailbox 收件箱
  mailagent admin stats -o json
  mailagent llm run 53675 --dry-run

Use "mailagent <COMMAND> --help" for more info.

$ mailagent email --help
$ mailagent email get --help
```

每个命令最少一个 `Examples:` 段落。

### 5.6 命令命名规约

- 资源名：单数（`email` 不是 `emails`），与 gh / kubectl 一致
- 动作名：动词原形（`get` / `list` / `delete` / `search` / `download`）
- 复合动作用连字符（`update-flag` / `page-orphans` / `cleanup-orphans` / `dead-letter` / `compare-paths`）
- 参数：长名优先（`--mailbox`），常用项加短名（`-o` 只给 `--output`）

---

## 6. 实现架构

### 6.1 包结构

```
src/cli/
├── __init__.py
├── main.py              # typer App + 注册子模块
├── context.py           # CliContext: 持有 repo / sync_store / notion_sync / llm_runner 单例
├── output.py            # 格式化: text / json / yaml / ndjson
├── auth.py              # API key 校验
├── exceptions.py        # CliError + exit_code 映射
└── commands/
    ├── __init__.py
    ├── email.py
    ├── attachment.py
    ├── llm.py
    ├── backfill.py
    ├── notion.py
    ├── project_progress.py
    ├── admin.py
    ├── init.py
    ├── calendar.py
    └── debug.py
```

### 6.2 框架：typer

理由（vs argparse / click）：
- type hints 友好：参数类型 + 默认值 + help 一处定义
- 子命令自然：`@app.command()` 装饰器
- 自动 help + 自动 shell completion（`mailagent --install-completion`）
- 与 pydantic / dataclass 协同好

**示例 skeleton**（`src/cli/main.py`）:

```python
import typer
from src.cli.commands import (
    email, attachment, llm, backfill, notion,
    project_progress, admin, init, calendar, debug,
)
from src.cli.context import CliContext

app = typer.Typer(
    name="mailagent",
    help="MailAgent CLI - Agent-friendly interface to the MailAgent backend.",
    no_args_is_help=True,
    rich_markup_mode="rich",
)

app.add_typer(email.app, name="email", help="邮件 CRUD / 搜索 / 重传")
app.add_typer(attachment.app, name="attachment", help="附件操作")
app.add_typer(llm.app, name="llm", help="LLM 处理")
app.add_typer(backfill.app, name="backfill", help="历史回填")
app.add_typer(notion.app, name="notion", help="Notion 直接操作")
app.add_typer(project_progress.app, name="project-progress", help="项目周报")
app.add_typer(admin.app, name="admin", help="统计 / 健康")
app.add_typer(init.app, name="init", help="初始化同步")
app.add_typer(calendar.app, name="calendar", help="日历相关")
app.add_typer(debug.app, name="debug", help="调试工具")


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
):
    """Global flags handler."""
    ctx.obj = CliContext.from_flags(
        output=output, quiet=quiet, verbose=verbose,
        db_path=db_path, api_key=api_key,
        config=config, no_color=no_color,
    )


if __name__ == "__main__":
    app()
```

**示例命令文件**（`src/cli/commands/email.py`）：

```python
import typer
from src.cli.context import CliContext
from src.cli.output import emit, emit_error

app = typer.Typer(no_args_is_help=True)


@app.command("get")
def get_email(
    ctx: typer.Context,
    internal_id: int = typer.Argument(...),
    include: str = typer.Option("", "--include",
        help="逗号分隔: body,attachments,all"),
):
    """获取邮件 metadata（默认）+ 可选 body / attachments。"""
    cli: CliContext = ctx.obj
    repo = cli.email_repo
    
    if "all" in include or "body" in include or "attachments" in include:
        full = repo.get_email_full(internal_id)
        if not full:
            emit_error(cli, "E_NOT_FOUND",
                f"Email with internal_id={internal_id} not found",
                exit_code=1)
            return
        data = _full_to_payload(full, include)
    else:
        meta = repo.get_metadata(internal_id)
        if not meta:
            emit_error(cli, "E_NOT_FOUND",
                f"Email with internal_id={internal_id} not found",
                exit_code=1)
            return
        data = _meta_to_payload(meta)
    
    emit(cli, data)
```

### 6.3 CliContext 单例 / 依赖注入

```python
# src/cli/context.py
from dataclasses import dataclass
from typing import Optional
from src.config import config as global_config
from src.repository import EmailRepository, AttachmentStore
from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync


@dataclass
class CliContext:
    """长寿命对象集中点：lazy-init 但只一次。"""
    output: str = "text"
    quiet: bool = False
    verbose: bool = False
    db_path: Optional[str] = None
    api_key: Optional[str] = None
    no_color: bool = False
    
    _email_repo: Optional[EmailRepository] = None
    _sync_store: Optional[SyncStore] = None
    _notion_sync: Optional[NotionSync] = None
    
    @classmethod
    def from_flags(cls, ...): ...
    
    @property
    def email_repo(self) -> EmailRepository:
        if self._email_repo is None:
            self._email_repo = EmailRepository(
                db_path=self.db_path or global_config.sync_store_db_path,
                attachment_store=AttachmentStore(global_config.attachment_storage_dir),
            )
        return self._email_repo
    
    @property
    def sync_store(self) -> SyncStore:
        if self._sync_store is None:
            self._sync_store = SyncStore(
                self.db_path or global_config.sync_store_db_path
            )
        return self._sync_store
    
    @property
    def notion_sync(self) -> NotionSync:
        if self._notion_sync is None:
            # 用 PR-1 strict DI 接口
            self._notion_sync = NotionSync(
                email_repo=self.email_repo,
                sync_store=self.sync_store,
            )
        return self._notion_sync
    
    def require_auth(self):
        """写操作前调；校验失败 raise CliAuthError"""
        expected = global_config.mailagent_cli_api_key  # 新加 config 字段
        provided = self.api_key
        if not expected:
            return  # 服务端未配 token → 默认不要求（开发模式）
        if not provided or not hmac.compare_digest(expected, provided):
            raise CliAuthError("Invalid or missing API key")
```

### 6.4 Output 模块

```python
# src/cli/output.py
def emit(ctx, data, *, ndjson=False):
    """Render data per ctx.output. text/json/yaml/ndjson."""
    if ctx.output == "json":
        if ndjson:
            for item in data:
                print(json.dumps(item, ensure_ascii=False, default=str))
        else:
            print(json.dumps({"status": "success", "data": data,
                              "meta": {...}}, ensure_ascii=False, default=str))
    elif ctx.output == "yaml":
        yaml.dump({"status": "success", ...}, sys.stdout)
    else:
        # text: 表格 / 单条 / 自定义渲染
        _render_text(ctx, data)


def emit_error(ctx, code, message, *, exit_code=1):
    payload = {"status": "error", "code": code, "message": message,
               "meta": {...}}
    if ctx.output in ("json", "yaml"):
        print(json.dumps(payload) if ctx.output == "json" else yaml.dump(payload),
              file=sys.stderr)
    else:
        print(f"Error [{code}]: {message}", file=sys.stderr)
    raise typer.Exit(code=exit_code)
```

### 6.5 pyproject.toml

新增/更新（**v2 改**：pin typer 上限 + Python 版本口径澄清）：

```toml
[project]
name = "mailagent"
requires-python = ">=3.9"      # 与现有 pyproject + 远程 webhook 一致
# CLI 自身在 3.11+ 测试（本地开发版本），但 package 仍兼容 3.9+

[project.scripts]
mailagent = "src.cli.main:app"

[project.optional-dependencies]
cli = [
    "typer>=0.12,<0.14",       # v2: pin 上限，避免 0.x 时期破坏性 release
    "rich>=13,<15",            # 表格 + 颜色
    "pyyaml>=6,<7",            # yaml output
]
```

**版本口径**:
- Package：`requires-python = ">=3.9"`（与 webhook-server 远程 VPS 一致，不变）
- CLI：tested on macOS Python 3.11+（与 main.py / pm2 一致）
- RFC TL;DR 不再单方声明"Python 3.11+"，避免与 pyproject 不一致

**测试约束**:
- 补 `tests/cli/test_typer_help_snapshot.py`：用 `typer.testing.CliRunner` 跑所有 `--help`，
  snapshot 文本，防 typer 升级时静默改 help layout
- 补 `tests/cli/test_config_factory.py`：测 `--config x.toml` 真的覆盖 `.env` 中字段

**安装**:
```bash
pip install -e ".[cli]"
which mailagent
mailagent --version
mailagent --install-completion zsh    # typer 自带 shell completion
```

### 6.6 单测

每个命令至少：
- 1 个 happy path（`mailagent email get 53675` → 命中）
- 1 个 not found（`mailagent email get 99999` → exit 1 + E_NOT_FOUND）
- 1 个 output format（`-o json` 输出可被 `json.loads` 解析）

辅助 fixture：`tmp_db`（pytest-mocker 起空 SQLite）+ `seed_email`（插一封邮件）+ `cli_runner`（typer.testing.CliRunner）。

测试目录：`tests/cli/test_<command>.py`。

---

## 7. JSON Schema 标准（**v2 重写**：真 schema spec 而非 sample JSON）

每个 agent-facing 命令必须有一份 JSON Schema 契约文档落在 `docs/cli-schema/<command>.schema.json`，
含 `$schema`、`schema_version`、`required`、`enum`、`nullable`、`additionalProperties: false` 等规范字段。下面是**示例化的代表**，PR-2 时为每个命令落具体 schema 文件。

**通用规则**:

1. **顶层结构始终是 wrapper object**（见 §5.1.2）：
   - `status`: enum `["success", "error", "partial_failure"]`
   - `schema_version`: integer，初始 `1`，breaking change 走 major bump
   - `data` | `error`: 互斥（success/partial_failure 用 data；error 用 error）
   - `meta`: object，含 `duration_ms` (number) + 命令特定字段（如 list 的 total/limit/offset）

2. **字段拆数字 vs 字符串**：v1 里 `llm run` 的 `tokens: "4521/342"`、`cache: "c=0 r=4321"`
   这种字符串拼接是反模式。v2 要求：
   - **数字字段单独成 key**：`input_tokens`、`output_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens` 都是 integer
   - **业务 label + machine key 双字段**：含 emoji / 中文 / display 形态的值（如 `priority="🟡 重要"`）
     必须同时给 `priority_key`（machine-readable enum，如 `"important"`）和 `priority_label`
     （display, 含 emoji）
   - **时间格式统一**：ISO 8601 含时区（如 `"2026-05-15T10:23:45+08:00"`），不再用纯日期或 epoch

3. **错误 schema 规范**：
   - `error.code` enum 集中维护（参见 `docs/cli-schema/error-codes.md`），命名 `E_NOT_FOUND` / `E_AUTH_FAILED` / `E_INVALID_QUERY` / `E_PM2_RUNNING` 等
   - `error.message` 人类可读
   - `error.hint` (optional) 给出 next step 提示
   - `error.context` (optional) 多结构化字段供 agent 解析

4. **partial-failure schema**（batch 命令）：
   ```json
   {
     "status": "partial_failure",
     "data": {"succeeded": [...], "failed": [{"internal_id": N, "error": {...}}],
              "summary": {"total": N, "succeeded": M, "failed": K, "aborted_by": null}}
   }
   ```

5. **NDJSON 流元数据规范**：最后一行必须是 `{"_meta": {...}}`。错误行的 `error` 字段嵌入对象内。

### 7.0 `docs/cli-schema/` placeholder 清单（PR-2 / PR-3 落地）

PR-2 起把所有 schema 落地到这些文件，供 agent autocomplete 和契约校验：

```
docs/cli-schema/
├── _common.schema.json          # wrapper / error / meta 通用结构
├── error-codes.md               # 所有 error.code enum + 含义
├── email-get.schema.json
├── email-list.schema.json
├── email-body.schema.json
├── email-search.schema.json
├── email-resync.schema.json     # 含 partial_failure 形态（batch 模式）
├── email-delete.schema.json
├── attachment-list.schema.json
├── attachment-download.schema.json   # 二进制下载，仅 dry-run / 失败时返回 JSON
├── llm-run.schema.json
├── llm-stats.schema.json
├── llm-compare-paths.schema.json
├── admin-stats.schema.json      # 涵盖 v4_rollout 指标
├── admin-dead-letter.schema.json
├── backfill-body.schema.json    # 长任务，含 partial_failure
├── backfill-derivatives.schema.json
├── notion-resync.schema.json
├── notion-page-orphans.schema.json
├── notion-file-link-audit.schema.json
├── init-*.schema.json (7 个 actions)
├── calendar-recurring-*.schema.json
└── project-progress-sync.schema.json
```

PR-2 MVP 时优先落 `email-get / email-list / email-search / email-body / admin-stats / _common / error-codes`，其他 PR-3/PR-4 时补。

### 7.1 `mailagent email get` (示例 schema 化)

```json
{
  "status": "success",
  "data": {
    "internal_id": 53675,
    "message_id": "<xxx@example.com>",
    "thread_id": "<yyy@example.com>",
    "subject": "RE: ...",
    "sender": "a@example.com",
    "sender_name": "Alice",
    "to_addr": "b@example.com",
    "cc_addr": "",
    "date_received": "2026-05-15T10:23:45+08:00",
    "mailbox": "收件箱",
    "is_read": true,
    "is_flagged": false,
    "sync_status": "synced",
    "notion_page_id": "36215375-830d-...",
    "notion_url": "https://www.notion.so/36215375830d...",
    "body": {
      "format": "html",
      "size_bytes": 8231,
      "has_inline_images": true,
      "fetched_at": 1715762625.123,
      "fetched_source": "applescript"
    },
    "attachments": [
      {"id": 1024, "filename": "report.pdf", "size_bytes": 245678,
       "content_type": "application/pdf", "is_inline": false,
       "derived_from": null, "notion_file_id": "..."},
      {"id": 1025, "filename": "report.csv", "size_bytes": 1234,
       "content_type": "text/csv", "is_inline": false,
       "derived_from": 1024, "derived_format": "csv"}
    ]
  },
  "meta": {"duration_ms": 8}
}
```

`--include` 不含 body 时 `body=null`；不含 attachments 时 `attachments=[]`。

### 7.2 `mailagent email search` (NDJSON 流)

```
{"internal_id": 53675, "subject": "...", "sender": "...", "date_received": "...", "mailbox": "...", "snippet": "...<mark>redis</mark>...", "rank": -2.34, "notion_page_id": "...", "notion_url": "..."}
{"internal_id": 53676, ...}
...
{"_meta": {"query": "redis timeout", "total_hits": 87, "limit": 50, "duration_ms": 23}}
```

### 7.3 `mailagent email resync` (JSON)

```json
{
  "status": "success",
  "data": {
    "internal_id": 53675,
    "old_page_id": "36215375-...",
    "new_page_id": "36215375-...",
    "action": "replaced",
    "attachments_uploaded": 3,
    "attachments_failed": 0,
    "thread_relations_updated": true
  },
  "meta": {"duration_ms": 4521}
}
```

### 7.4 `mailagent llm run` (示例 schema 化 — v2 修：字段拆数字 + 双 label/key)

```json
{
  "status": "success",
  "schema_version": 1,
  "data": {
    "internal_id": 53675,
    "page_id": "36215375-...",
    "mailbox": "收件箱",
    "dry_run": false,
    "labels": {
      "priority_key": "important",
      "priority_label": "🟡 重要",
      "action_type_key": "需要回复",
      "action_type_label": "需要回复",
      "category_key": "project_communication",
      "category_label": "项目沟通",
      "ai_summary": "...",
      "language": "Chinese",
      "sender_priority_key": "important_partner",
      "sender_priority_label": "重要伙伴",
      "action_required": true,
      "daily_digest_date": "2026-05-15"
    },
    "usage": {
      "input_tokens": 4521,
      "output_tokens": 342,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 4321,
      "model": "claude-sonnet-4-6",
      "latency_ms": 2341
    },
    "writer_summary": {
      "fields_written": ["ai_summary", "category", "priority", "action_type"],
      "fields_skipped": []
    }
  },
  "meta": {"duration_ms": 2341}
}
```

**字段说明**（关键 enum）:
- `priority_key`: `"critical" | "urgent" | "important" | "normal" | "low"`
- `action_type_key`: 收件箱 `"需要回复" | "需要决策" | ...`；发件箱独立枚举（参见 `src/llm_agent/schema.py`）
- `language`: ISO 名（"Chinese" / "English" / "Other"）
- 所有 emoji-bearing label 都同时给 `_key` (machine) 和 `_label` (display)

### 7.5 `mailagent admin stats` (v2 改名 + 指标来源澄清)

```json
{
  "status": "success",
  "schema_version": 1,
  "data": {
    "watcher": {
      "polls": 12453, "emails_synced": 8421, "errors": 12,
      "consecutive_errors": 0,
      "_source": "stats_reporter_last_snapshot"
    },
    "sync_store": {
      "total_emails": 8493,
      "by_status": {"synced": 7891, "pending": 0, "dead_letter": 12, "fetch_failed": 5, "failed": 3, "skipped": 582},
      "db_size_mb": 234.5,
      "_source": "live_query"
    },
    "handlers": {
      "fetch_mail_content_sqlite_p99_ms": 8,
      "fetch_mail_content_applescript_p99_ms": 1432,
      "search_email_bodies_p99_ms": 23,
      "_source": "stats_reporter_last_snapshot"
    },
    "v4_rollout": {                                    // v2 改名（v1 v4_grayscale → v4_rollout）
      "from_sqlite_hit": 421,
      "fallback_miss": 0,
      "fallback_error": 0,
      "rollout_route_latency_p99_ms": 12,
      "body_miss_internal_ids_sample": [],             // 仅记最近 10 个，方便定位
      "_source": "stats_reporter_last_snapshot",
      "_snapshot_at": "2026-05-16T01:30:00+08:00",
      "_warn_if_stale_sec": 300
    }
  },
  "meta": {"duration_ms": 12}
}
```

**字段语义** (v2 关键澄清):

- `_source: "live_query"` 表示该 section 由 CLI 直接查 SQLite 算出
- `_source: "stats_reporter_last_snapshot"` 表示来自 main.py 进程上报的快照
  （通过 stats_reporter 推到 dashboard 或写本地 SQLite stats 表）
- `_snapshot_at` + `_warn_if_stale_sec` 让 agent 能识别"指标过期"
  （如 mail-sync 停了 30 分钟，stats 是 stale 数据）

**为什么这么设计**（Codex C10）: CLI 是短进程；NotionSync 内的 in-memory counter
对短命 CLI 总是 0。**指标必须持久化或经由 stats_reporter** —— 详见 §8。

---

## 8. v4 rollout 监控（顺便落地 R-06 / I-11；**v2 改：必须持久化**）

**v1 设计漏洞**（Codex C10 / B5 指出）：v1 写"`NotionSync.get_stats()` 给 watcher" 看似合理，
但 CLI 是短进程，新建的 in-memory counter 是 0。真实命中数在 PM2 `mail-sync` 进程内存里，
CLI `admin stats` 拿不到。**仅"补到 admin stats"不够**。

**v2 正确方案**（三选一，PR-4 拍板）：

### 选项 A（推荐）：新增 SQLite stats 表，定期 flush

```sql
CREATE TABLE v4_rollout_stats (
    snapshot_at REAL PRIMARY KEY,        -- epoch
    from_sqlite_hit INTEGER NOT NULL,
    fallback_miss INTEGER NOT NULL,
    fallback_error INTEGER NOT NULL,
    route_latency_p99_ms INTEGER,
    body_miss_internal_ids TEXT          -- JSON array, 最近 10 个
);
```

- `NotionSync` 在内存累加；每分钟（与 stats_reporter 同步周期）由 watcher
  flush 一行
- CLI `admin stats` 查最新一行 + `_snapshot_at` + `_warn_if_stale_sec=300`
- 实施成本：低（已有 sync_state / sync_store 表写惯例）

### 选项 B：接入现有 stats_reporter collector

`main.py` 已有 `stats_reporter.add_collector("v4_rollout", lambda: notion_sync.get_stats())`，
推到远程 dashboard API；CLI 走 dashboard HTTP API 查询。

- 实施成本：中（需 CLI 知道 dashboard URL + auth）
- 副作用：CLI 依赖远端服务

### 选项 C：UNIX socket / shared memory

PM2 mail-sync 暴露本地 UNIX socket（如 `/tmp/mailagent.sock`），CLI 连进去查。

- 实施成本：高（要写 IPC server / client）
- 不推荐

**RFC 推荐 A**：本地、零额外依赖、与现有 SQLite 模式一致。CLI 读取时显示 `_snapshot_at`
让 agent 判断指标是否 stale。**PR-4 落地**。

### 命名变更

| v1 | v2 | 理由 |
|---|---|---|
| `v4_grayscale` | `v4_rollout` | "grayscale" 英文歧义（灰阶 vs canary rollout）；rollout 更准 |
| `from_sqlite_hit` | 保留 | OK |
| `fallback_miss` | 保留 | OK，注意"miss"在这里指"SQLite body 没找到所以走 fallback"，不是 cache miss |
| `fallback_error` | 保留 | OK |

### dashboard 集成（webhook-server）

PR-4 之后，webhook-server dashboard.html 加 "v4 Rollout" panel：
- 命中率曲线（hit / (hit + fallback_miss + fallback_error)）
- body_miss_internal_ids 列表（agent 可点进去单封 resync）
- route_latency_p99_ms 曲线对比 fetch_mail_content sqlite 路径
- _snapshot_at 显示与告警（stats_reporter 上报间隔默认 60s，stale > 300s 红色警告）

---

## 9. scripts/ 迁移表（R-05 + D2，**v2 重排**）

> **Status (2026-05-16)**：✅ **PR-5 / PR-6 已完成** —— PR-5 把 13 个 thin wrapper + 29 个 dev / 4 个 archive 迁完位，PR-6 git rm 6 个真 thin wrapper + 5 个 CLI 依赖 module 删 `__main__` 入口收口为 import-only。下方 §9.1 - §9.6 表格保留为历史决策快照；当前形态见 §9.6 "post-PR-6 实际形态"。

**v2 修正**：scripts/ 顶层实测 **44 个文件**（v1 报错 47，已重数）。迁移表 v2 重排：

1. `replay_recurring_invite.py` 从 dev/ 移到核心 CLI（→ `mailagent calendar recurring`）
2. `compare_llm_path.py` 从 dev/ 移到核心 CLI（→ `mailagent llm compare-paths`）
3. `cleanup_*.py` 三个从 dev/ 移到 admin 命令（cleanup syncstore / cleanup duplicates / repair-parents）
4. `initial_sync.py` 映射补完整 7 个 actions
5. `manual_sync.py` 决断：是 hardcoded debug 脚本，迁成 `mailagent debug manual-sync`（不删，保留 debug 价值）

### 9.1 核心生产 CLI → 整合到 mailagent（PR-3/PR-4 时改写）

| 旧脚本 | 新 CLI 命令 | 处置 |
|---|---|---|
| `scripts/initial_sync.py` | `mailagent init {fetch-cache, analyze, fix-properties, fix-critical, update-parents, sync-new, all}` | thin wrapper，加 deprecation warning |
| `scripts/manual_sync.py` | `mailagent debug manual-sync`（保留 debug 价值，非 production CLI） | 移到 debug |
| `scripts/run_llm_on_email.py` | `mailagent llm run` | thin wrapper |
| `scripts/sync_project_progress.py` | `mailagent project-progress sync` | thin wrapper |
| `scripts/resync_notion.py` | `mailagent email resync`（支持 `--range` / `--ids`，**v2 合并 resync-range**） | thin wrapper |
| `scripts/backfill_email_body.py` | `mailagent backfill body` | thin wrapper |
| `scripts/backfill_derivatives.py` | `mailagent backfill derivatives` / `mailagent attachment derive`（alias） | thin wrapper |
| `scripts/export_email_content.py` | `mailagent debug email-source` | thin wrapper |
| `scripts/replay_recurring_invite.py` | `mailagent calendar recurring {discover, replay}`（**v2 新加**） | thin wrapper |
| `scripts/compare_llm_path.py` | `mailagent llm compare-paths`（**v2 升级为一等命令**） | thin wrapper |
| `scripts/cleanup_syncstore.py` | `mailagent admin cleanup syncstore`（**v2 改路径**） | thin wrapper |
| `scripts/cleanup_duplicate_message_ids.py` | `mailagent admin cleanup duplicates`（**v2 改路径**） | thin wrapper |
| `scripts/cleanup_notion_db.py` | `mailagent admin repair-parents`（**v2 改路径**） | thin wrapper |

**thin wrapper 示例**（`scripts/resync_notion.py` 改造后）：

```python
#!/usr/bin/env python3
"""DEPRECATED: use `mailagent email resync` instead.

This script forwards to the unified CLI for one release window before removal.
"""
import sys
import warnings
from src.cli.main import app

warnings.warn(
    "scripts/resync_notion.py is deprecated; use 'mailagent email resync' instead.",
    DeprecationWarning, stacklevel=2,
)
# argparse args 翻译成 typer args
# ... (~20 行翻译表)
app(["email", "resync", *translated_args])
```

### 9.2 检查 / 调试工具 → `scripts/dev/`（PR-5 移动）

**v2 移除**：`cleanup_*.py` 三个 / `compare_llm_path.py` / `replay_recurring_invite.py` 不再进 dev/，
全部升级为一等 CLI 命令（见 §9.1）。

| 旧脚本 | 处置 |
|---|---|
| `scripts/check_duplicate_message_ids.py` | mv `scripts/dev/` |
| `scripts/check_inline_images.py` | mv `scripts/dev/`（部分功能并入 `mailagent debug inline-images`） |
| `scripts/check_missing_ids.py` | mv `scripts/dev/` |
| `scripts/check_notion_database.py` | mv `scripts/dev/` |
| `scripts/check_special_chars.py` | mv `scripts/dev/` |
| `scripts/debug_conversion.py` | mv `scripts/dev/` |
| `scripts/debug_eventkit.py` | mv `scripts/dev/` |
| `scripts/debug_full_children.py` | mv `scripts/dev/` |
| `scripts/debug_mail_structure.py` | 并入 `mailagent debug mail-structure`，旧文件 mv |
| `scripts/debug_notion_payload.py` | mv `scripts/dev/` |
| `scripts/inspect_all_unread.py` | mv `scripts/dev/` |
| `scripts/inspect_latest_email.py` | mv `scripts/dev/` |

### 9.3 旧式测试 → `scripts/dev/` 或归档

| 旧脚本 | 处置 |
|---|---|
| `scripts/test_attachments.py` | mv `scripts/dev/` |
| `scripts/test_eventkit.py` | mv `scripts/dev/` |
| `scripts/test_fake_content_type.py` | mv `scripts/dev/` |
| `scripts/test_keep_alive.py` | mv `scripts/dev/` |
| `scripts/test_mail_reader.py` | mv `scripts/dev/` |
| `scripts/test_notion_api.py` | mv `scripts/dev/` |
| `scripts/test_office_converter.py` | mv `scripts/dev/`（与 `tests/` 下的真单测分开） |
| `scripts/test_remote_unlock.py` | mv `scripts/dev/` |
| `scripts/test_subitem_relation.py` | mv `scripts/dev/` |
| `scripts/test_table_conversion.py` | mv `scripts/dev/` |
| `scripts/test_v3_architecture.py` | mv `scripts/dev/` |

### 9.4 一次性迁移 → `scripts/archive/`

| 旧脚本 | 处置 |
|---|---|
| `scripts/migrate_sync_store_v3.py` | mv `scripts/archive/` |
| `scripts/backfill_internal_id.py` | mv `scripts/archive/` |
| `scripts/backfill_notion_id.py` | mv `scripts/archive/` |

### 9.5 Shell helper → 保留顶层

| 旧脚本 | 处置 |
|---|---|
| `scripts/create_reply_draft.sh` | 保留（被 `handle_create_draft` 调） |
| `scripts/deploy-webhook.sh` | 保留（运维入口） |
| `scripts/toggle_keep_alive.sh` | 保留（macOS 快捷指令绑定） |
| `scripts/html_clipboard.py` | 保留（被 handler 调用） |
| `scripts/keep_alive.py` | 保留（main.py 导入） |

### 9.6 PR-5 后顶层 `scripts/` 形态（v2 重排）

```
scripts/
├── archive/                          # 一次性迁移（3 个）
│   ├── migrate_sync_store_v3.py
│   ├── backfill_internal_id.py
│   └── backfill_notion_id.py
├── dev/                              # 检查 / 调试 / 旧测试（22 个）
│   ├── check_*.py (5)                # check_duplicate_message_ids, check_inline_images,
│   │                                 # check_missing_ids, check_notion_database, check_special_chars
│   ├── debug_*.py (5)                # debug_conversion, debug_eventkit, debug_full_children,
│   │                                 # debug_mail_structure, debug_notion_payload
│   ├── inspect_*.py (2)              # inspect_all_unread, inspect_latest_email
│   └── test_*.py (10)                # test_attachments, test_eventkit, test_fake_content_type,
│                                     # test_keep_alive, test_mail_reader, test_notion_api,
│                                     # test_office_converter, test_remote_unlock,
│                                     # test_subitem_relation, test_table_conversion,
│                                     # test_v3_architecture
├── thin-wrapper （deprecation 期，11 个）
│   ├── initial_sync.py               # → mailagent init {...}
│   ├── manual_sync.py                # → mailagent debug manual-sync
│   ├── run_llm_on_email.py           # → mailagent llm run
│   ├── sync_project_progress.py      # → mailagent project-progress sync
│   ├── resync_notion.py              # → mailagent email resync (含 --range)
│   ├── backfill_email_body.py        # → mailagent backfill body
│   ├── backfill_derivatives.py       # → mailagent backfill derivatives
│   ├── export_email_content.py       # → mailagent debug email-source
│   ├── replay_recurring_invite.py    # v2 新加 → mailagent calendar recurring {...}
│   ├── compare_llm_path.py           # v2 新加 → mailagent llm compare-paths
│   ├── cleanup_syncstore.py          # v2 新加 → mailagent admin cleanup syncstore
│   ├── cleanup_duplicate_message_ids.py  # v2 新加 → mailagent admin cleanup duplicates
│   └── cleanup_notion_db.py          # v2 新加 → mailagent admin repair-parents
└── 真 legacy / 系统 hook（5 个）
    ├── create_reply_draft.sh         # handle_create_draft 调用
    ├── deploy-webhook.sh             # 运维入口
    ├── toggle_keep_alive.sh          # macOS 快捷指令绑定
    ├── html_clipboard.py             # handle_create_draft 调用
    └── keep_alive.py                 # main.py 导入

# 总数: 3 + 22 + 13 + 5 = 43 个文件分类（少 1 个：v1 误数 manual_sync 漏归类）
# v2 校对：scripts/ 顶层 44 个（v1 报 47 错），其中 1 个 manual_sync 归 thin-wrapper

合计：13 个 thin wrappers（含 manual_sync）+ 5 个真 legacy = 18 个顶层文件
   + 25 个归档/dev = 顶层 18 + 2 子目录共 3 个 deep dir。
```

### 9.7 post-PR-6 实际形态（2026-05-16 ship 后）

PR-6 git rm 6 个真 thin wrapper + 5 个 CLI 依赖 module 删 `__main__` 入口后，顶层
`scripts/` 收口为：

```
scripts/
├── __init__.py
├── archive/                          # 一次性历史 migration / PoC（PR-5 归位）
│   ├── README.md
│   ├── migrate_sync_store_v3.py
│   ├── backfill_internal_id.py
│   ├── backfill_notion_id.py
│   └── poc_markdown_api.py
├── dev/                              # 检查 / 调试 / 旧测试 harness（PR-5 归位，~25 个）
│   ├── README.md
│   ├── check_*.py / debug_*.py / inspect_*.py / test_*.py
│   └── ...
├── import-only modules（5 个，PR-6 删 __main__ 入口）
│   ├── initial_sync.py              # CLI 调 InitialSync / AnalysisReport / main()
│   ├── cleanup_syncstore.py         # CLI 调 show_stats / reset_sync_status
│   ├── cleanup_duplicate_message_ids.py  # CLI 调 get_all_pages / extract_page_info / archive_page
│   ├── cleanup_notion_db.py         # CLI 调 NotionDBCleaner
│   └── replay_recurring_invite.py   # CLI 调 discover_recurring / replay_one
└── 真 legacy / 系统 hook（5 个）
    ├── create_reply_draft.sh         # handle_create_draft 调用
    ├── deploy-webhook.sh             # 运维入口
    ├── toggle_keep_alive.sh          # macOS 快捷指令绑定
    ├── html_clipboard.py             # handle_create_draft 调用
    └── keep_alive.py                 # main.py 导入
```

**变更要点**:
- **6 个 git rm**：`backfill_email_body.py` / `backfill_derivatives.py` / `sync_project_progress.py` / `compare_llm_path.py` / `run_llm_on_email.py` / `resync_notion.py`（旧用法直接报 "No such file or directory"）
- **5 个保留 import-only**：模块 docstring 标 "DEPRECATED — import only"，移除 `if __name__ == '__main__'` + `DeprecationWarning` + `asyncio.run` 入口；CLI inline 仍直调其类 / 函数
- 顶层 `__init__.py` 保留（CLI `from scripts.X import Y` 依赖 namespace）
- **PR-6 spec 偏差**：原 spec §2.1 把 `replay_recurring_invite.py` 列入"7 个真 thin wrapper 可删"，但 `src/cli/commands/calendar.py:193,377` 实际 import `discover_recurring` / `replay_one` async 函数 → 整体删会 ImportError，改归 "保留 + 删 `__main__`" 桶

post-PR-6 顶层 `.py` 数：5 import-only + 2 production helper + 1 `__init__.py` = **8 个**（比 PR-5 ship 时 14 个少 6 个，全部为删除的 thin wrapper）。

---

## 10. PR 拆分

按依赖串行：

### PR-1 — Refactor 前置（**v2 扩展**：补 R-02 / R-03 / R-07 + I-01 / I-02 fix）

**变更**:

- **R-01 NotionSync strict DI**:
  - `src/notion/sync.py`：`NotionSync.__init__` 改 strict DI，删 `_ensure_sqlite_resources` / `_repo / _sync_store` Optional
  - `src/mail/new_watcher.py`：传 repo + sync_store 给 NotionSync
  - `src/mail/reverse_sync.py`：构造 NotionSync 时传依赖
- **D3 EmailFull**:
  - `src/repository/email_repository.py`：新增 `EmailMetadataRecord` + `EmailFull` dataclass + `get_metadata` + `get_email_full` 方法
- **R-04 AttachmentStore 绝对路径**:
  - `src/repository/attachment_store.py`：`__init__` resolve 绝对路径，`read` 兼容相对/绝对 local_path
- **v2 新增 R-02 thread relations 切 SQLite SSoT**:
  - `src/repository/email_repository.py`：新增 `ThreadMember` dataclass + `get_thread_members` 方法
  - `src/notion/sync.py:_handle_thread_relations`：改走 SQLite 优先 + Notion fallback
  - `src/config.py`：新加 `THREAD_RELATIONS_FALLBACK_TO_NOTION` flag
- **v2 新增 R-03 删 `fetched` 状态**:
  - `src/mail/sync_store.py:81`：删 TypedDict 注释中的 `fetched`
  - `src/mail/sync_store.py:1302`：`get_emails_by_status` docstring 同步删
- **v2 新增 R-07 文档同步**:
  - `docs/architecture_v4_sqlite_ssot.md` 状态流转段更新
  - `CLAUDE.md` "状态流转"段更新
  - `docs/backend-review-2026-05.md` 注 I-02 / R-02 / R-03 标 fixed
- **测试**:
  - `tests/notion/test_create_from_sqlite.py::test_disabled_by_default`：补 monkeypatch（I-01 fix）
  - `tests/repository/test_email_repository.py`：补 `TestGetEmailFull` + `TestGetThreadMembers`
  - `tests/notion/test_thread_relations_sqlite_first.py`：新增（R-02 e2e）
  - `tests/mail/test_sync_store_status_machine.py`：新增（assert `fetched` 永不写入）
  - `tests/repository/test_attachment_store.py::TestAbsolutePath`：新增（R-04）

**风险**：中（thread relations 改造涉及 production 路径；新增 dataclass / DI 改动稳）。
**回归测试**：现有 295 → 296+（新增 ~5 个测试），全绿。
**预估**：2-3 天（含 R-02 灰度验证）。

### PR-2 — CLI 骨架 + MVP 命令

**变更**:
- `pyproject.toml`：加 `[project.scripts]` + `[project.optional-dependencies].cli`
- `src/cli/{__init__,main,context,output,auth,exceptions}.py`：骨架
- `src/cli/commands/email.py`：`get / list / body / search`
- `src/cli/commands/admin.py`：`stats / health / db-version`
- `tests/cli/test_email.py + test_admin.py`：happy / not-found / output format
- `docs/cli-schema/`：每个命令的 JSON schema md
- `docs/CLAUDE.md` 加 CLI 章节（暂时简版）

**风险**：低（新增包，不动现有路径）。
**预估**：2 天。

### PR-3 — CLI 完整命令（除 backfill / project-progress / init）

**变更**:
- `src/cli/commands/{attachment,llm,notion,calendar,debug}.py`
- `tests/cli/test_*.py` 对应
- `docs/cli-schema/` 补完

**预估**：2-3 天。

### PR-4 — CLI batch 命令 + 长任务（**v2 扩展**：长任务契约 + PM2 检测 + checkpoint）

**变更**:

- `src/cli/commands/{backfill,project_progress,init,email_resync_range}.py`：批量命令
- 长任务契约（**v2 补**：v1 比 `backfill_email_body.py / resync_notion.py` 现有契约还简化了，
  v2 必须对齐或加强）:
  - SIGINT 第一次 → 当前 unit 跑完，输出 summary，退出码 130 + status='aborted'
  - SIGINT 第二次 → 立即退出（`sys.exit(130)`），不等当前 unit
  - SIGTERM → 同 SIGINT 第一次
  - 退出码细分：
    - `0` 全部 OK
    - `1` 业务失败（非 batch 模式）
    - `6` batch partial_failure（部分成功）
    - `7` aborted by SIGINT
    - `8` max-failures 熔断
    - `9` PM2 mail-sync 正在跑（写命令冲突）
- **PM2 detection**:
  - `backfill body` / `email resync` (batch) 启动前调 `pm2 status mail-sync` 检测
  - 如果 status='online' → 默认拒绝退出 9 + hint："Stop pm2 first or pass --allow-concurrent"
  - `--allow-concurrent` flag 显式跳过（生产灰度期某些场景需要）
- **Checkpoint / resume**:
  - 每个长任务每 N 个 unit（默认 50）把 `last_completed_internal_id` 写 SQLite `cli_checkpoints` 表
  - `--resume-from N` flag 从 ID >= N 续跑
  - 退出（成功 / 中止）时打印 "Resume with: mailagent <cmd> --resume-from <N>"
- **进度回报**:
  - `rich.progress.Progress` 显示 bar + rate + ETA（text mode）
  - JSON mode 走 NDJSON 流式（每个 unit 一行）
- **v4 rollout 指标持久化（R-06 选项 A）**:
  - `src/mail/sync_store.py`：DB_VERSION 5 → 6，新增 `v4_rollout_stats` 表（schema 见 §8）
  - `src/notion/sync.py`：加 in-memory counter，watcher 每分钟 flush 到表
  - `src/cli/commands/admin.py:stats`：读最新 row + `_snapshot_at`

**新增测试**:
- `tests/cli/test_long_task_contract.py`：SIGINT 二次强退、退出码细分、PM2 检测、checkpoint resume
- `tests/cli/test_v4_rollout_stats.py`：flush + 读取
- `tests/mail/test_sync_store_v6_migration.py`：DB_VERSION 5 → 6

**预估**：3 天（v1 估 2 天偏短，v2 加入 PM2 检测 + checkpoint + 长任务契约对齐）。

### PR-5 — scripts/ 迁移 ✅ **已 ship**（commit 372f494, 2026-05-16）

**变更**:
- `git mv` 33 个文件到 `scripts/dev/` 和 `scripts/archive/`
- 顶层 13 个 thin wrappers / module-with-`__main__` 接通 CLI（subprocess wrap 全部 inline；5 个 stub 真接通：llm compare-paths / notion page-orphans / notion file-link-audit / calendar expand / attachment derive）
- 加 `scripts/dev/README.md` 和 `scripts/archive/README.md` 说明归类
- `docs/CLAUDE.md` 全文 update：`python3 scripts/X.py` → `mailagent <cmd>`
- pytest 650 → 655 passed（PR-5 final）

### PR-6 — deprecation cleanup ✅ **已 ship**（2026-05-16；4 周 release window 后）

**实际变更**（与最初 spec 偏差小幅修正）:
- `git rm` **6** 个真 thin wrapper（spec 原列 7 个，但 `replay_recurring_invite.py` CLI 实际依赖 `discover_recurring` / `replay_one`，整体不能删）：`backfill_email_body.py` / `backfill_derivatives.py` / `sync_project_progress.py` / `compare_llm_path.py` / `run_llm_on_email.py` / `resync_notion.py`
- **5** 个 CLI 依赖 module 删 `__main__` block 收口为 import-only：`initial_sync.py` / `cleanup_syncstore.py` / `cleanup_duplicate_message_ids.py` / `cleanup_notion_db.py` / `replay_recurring_invite.py`
- CLAUDE.md / agent-cli-rfc.md 全文搜 `python scripts/<wrapper>.py` 收口为 `mailagent <group> <action>`；保留 dev/ archive/ .sh 提及
- 归档 `docs/pr5-handoff-scripts-migration.md` + `docs/pr6-handoff-deprecation-cleanup.md` → `docs/archive/`
- pytest 仍 655 passed；DB_VERSION 仍 6；10 个 CLI group / 45+ schema / 退出码体系（0/1/2/4/5/6/7/8/9/130）不变

**实际工作量**：0.5 天（同 spec 预估）。

---

## 11. 风险 / 回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| typer + rich 依赖增加 venv 体积 | 极小（~5MB）| 接受 |
| `pip install -e .` 后某些用户 PATH 没 venv/bin → `mailagent` 找不到 | 中 | 装时打印 "use `./venv/bin/mailagent` if not in PATH"；docs 说明 |
| 长任务 SIGINT 中断时 SQLite 半事务 | 低 | EmailRepository 已经做 try/rollback；CLI 加 `try/finally close` |
| Help 文案 i18n | 低 | 默认中文（与 CLAUDE.md / docs 一致），不做 i18n |
| Stable JSON schema 未来需变化 | 中 | 加 `schema_version` 字段；breaking change 走 major version |
| thin wrapper 期间 docs 指向不一致 | 中 | PR-5 后立即更新；PR-2/3/4 中保持老路径可跑 |
| `--api-key` 在 shell history 暴露 | 低 | docs 推荐 `MAILAGENT_CLI_API_KEY` 环境变量；不在 history |

**整体回滚**：CLI 是新加包，删 `src/cli/` + 回退 `pyproject.toml` 即可。不动数据、不动其他模块（除 PR-1 的接口 refactor）。PR-1 的回滚由 git revert 完成。

**PR-1 单独回滚**：会同时破坏 PR-2 之后的 CLI。所以 PR-1 一旦合并就视为基础，回滚成本高。**建议 PR-1 上线后留 1-2 天观察期再合 PR-2**。

---

## 12. 待定项 / 后续 RFC

- **D5 / `mailagent serve`**：独立 RFC（用户已明确）。可能与 webhook-server 合并设计
- **Phase 5 Web 前端**：独立项目，但可能复用 `src/cli/commands/*` 的输出格式 / API key 鉴权
- **CLI completion 安装命令**：`mailagent --install-completion bash/zsh/fish`（typer 自带，文档需提）
- **CLI 内部 cache**：search / list 是否要 LRU 缓存结果以加速重复查询（暂不做）
- **CLI 上报 telemetry**：是否给 dashboard 上报 CLI 使用次数（暂不做）
- **agent 调用约定**：是否需要在 `docs/` 加 `agent-cli-usage.md` 说明给外部 agent 用的最佳实践（推荐做，PR-2 时落）
- **从 Notion 反向 backfill**：handoff §6 提到 `--source=notion` 模式（架构 doc §6），CLI 中暂不暴露，等 webhook-server 远程跑

---

## 13. 验收

RFC 通过的判据：
- 用户 review 后给 :+1: 或 propose 具体修改
- D1-D4 + CLI 名 + 命令风格 + 打包 + server-mode 范围 8 项已对齐 ✓
- PR-1 / PR-2 拆分边界清晰 ✓
- scripts/ 迁移表完整覆盖 47 个文件 ✓
- JSON schema 给到 agent 调用契约示例 ✓
- 退出码 / 认证 / 输出格式 / 配置优先级标准化 ✓
- 实现框架（typer）和入口 (`mailagent`) 选定 ✓

如果用户 ack，下一个 session 入口：开始实施 PR-1（NotionSync DI + EmailFull + AttachmentStore resolve + I-01 fix）。

---

## 附录 A：现有 Python API 接口速查（CLI 实现时直接用）

```python
# EmailRepository (要 + get_metadata + get_email_full)
repo.get_metadata(internal_id) -> Optional[EmailMetadataRecord]    # 新增
repo.get_email_full(internal_id) -> Optional[EmailFull]            # 新增
repo.get_body_html(internal_id) -> Optional[str]
repo.get_body_markdown(internal_id, max_chars=-1) -> Optional[str]
repo.get_body(internal_id) -> Optional[EmailBodyRecord]
repo.get_attachments(internal_id) -> list[AttachmentRecord]
repo.get_attachment_bytes(att_id) -> Optional[bytes]
repo.search_email_bodies(query, *, limit, mailbox, since_date, until_date) -> list[EmailSearchHit]
repo.commit_email_with_body(internal_id, body, attachments, *, message_id) -> dict[str, int]
repo.update_notion_links(internal_id, *, page_id, file_id_map, block_id_map) -> None
repo.delete_email_full(internal_id) -> None

# SyncStore (CLI 不直接调，但 admin 命令需要)
ss.get_stats() -> SyncStoreStats
ss.get_dead_letter_emails(limit) -> list
ss.retry_dead_letter(message_id) -> bool
ss.search_emails(filters, limit, offset) -> dict
ss.get_pending_emails(limit) -> list
ss.get_emails_by_status(status, limit) -> list
ss.iter_series_needing_expansion(cutoff_iso) -> Iterator

# NotionSync (PR-1 strict DI 后)
ns.create_email_page_from_sqlite(internal_id, *, repo, sync_store, ...) -> Optional[str]
ns.update_email_flags(page_id, is_read, is_flagged, processing_status) -> None
ns.update_page_mail_sync_status(page_id, synced, processing_status) -> None
ns.query_pages_for_reverse_sync() -> list
ns.client.client.pages.update(page_id, archived=True)  # archive

# LLMRunner
runner.run_for_internal_id(internal_id, *, dry_run, overwrite, force) -> dict

# EventHandlers (admin stats 用)
handlers.get_stats() -> dict

# health_check
SyncHealthCheck(...).check() -> list[int]
```

---

## 附录 B：与现有 CLAUDE.md 的整合点

CLI 上线后 CLAUDE.md 需要更新（PR-2 / PR-5 中分两次做）：

1. **§命令速查**：所有 `python3 scripts/X.py` 改 `mailagent <cmd>`
2. **§ Webhook Server**：不变（webhook-server 是独立服务）
3. **§ LLM Agent → CLI**：`python scripts/run_llm_on_email.py --internal-id N` → `mailagent llm run N`
4. **§ 项目周报同步 → 命令**：所有 `python scripts/sync_project_progress.py` → `mailagent project-progress sync`
5. **§ v4 架构 → Phase 4 重传 CLI**：所有 `python scripts/resync_notion.py` → `mailagent email resync`
6. **§ T-02 历史邮件 backfill**：所有 `python scripts/backfill_email_body.py` → `mailagent backfill body`
7. **§ 运维**：admin stats / health / db-version 一节加进去

---

## 14. Changelog v1 → v2

吸纳 Codex GPT-5.5 highest-effort review 反馈（Approved with changes）。每条吸纳都标注 Codex 反馈编号。

### v2 必改（Concerns / Blockers）

| Codex 编号 | 改动 | RFC 章节 |
|---|---|---|
| **C1 + B2** | 补 `replay_recurring_invite.py` → `mailagent calendar recurring {discover, replay}` | §4.10 / §9.1 |
| **C2 + B2** | `mailagent init` 补全 7 个 actions（fix-properties / fix-critical / update-parents / sync-new / `--report-in/out` / `--skip-fetch`）| §4.9 / §9.1 |
| **C3** | scripts/ 顶层数量 47 → **44**（verify 通过），迁移表重新生成 | §9 / §9.6 |
| **C4** | `email resync-range` 合并到 `email resync --range / --ids`；`attachment derive` 改 alias，主入口移到 `backfill derivatives` | §4.2 / §4.3 |
| **C5 + B3** | JSON Schema 改真规范（`$schema` / `schema_version` / required / enum / additionalProperties / error / partial-failure / NDJSON meta），落 `docs/cli-schema/` placeholder 清单 | §7 |
| **C6** | `--output json` 不再默认 NDJSON；NDJSON 独立 `--output ndjson` 或 `--stream` | §5.1 |
| **C7** | `attachment download` 的 `-o` → `--dest`（避开全局 `-o/--output` 冲突） | §4.3 |
| **C8** | 写命令默认要 token；服务端未配 token 时**默认拒绝**，开发模式显式 `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` | §5.3 |
| **C9** | 配置加载改 `load_cli_config(config_path, env, flags)` factory；不再依赖 module-level singleton 的 `from src.config import config` | §5.4 |
| **C10 + B5** | v4 rollout 指标必须持久化（推荐选项 A：SQLite stats 表 + 每分钟 flush），CLI `admin stats` 读快照 + `_snapshot_at` + `_warn_if_stale_sec` | §7.5 / §8 |
| **B1** | R-02 (`_handle_thread_relations` 切 SQLite SSoT) 真正方案化进 PR-1 | §3.4 / PR-1 |
| **B1** | R-03 (`fetched` 状态决断: 删) 真正方案化进 PR-1（v1 误把 R-03 标签给了 D3） | §3.5 / PR-1 |
| **B1 + R-07** | 删 fetched 后同步 architecture / CLAUDE.md / backend-review 三处文档 | §3.5 / PR-1 |
| **B4** | 长任务契约补：SIGINT 二次强退 / 退出码 6-9 细分 / PM2 running 检测 / checkpoint resume / `--allow-concurrent` | §5.2 / PR-4 |

### v2 吸纳（Suggested Improvements）

| Codex 编号 | 改动 | RFC 章节 |
|---|---|---|
| **S2** | `v4_grayscale` 命名 → `v4_rollout`（避免英文 grayscale 歧义） | §7.5 / §8 |
| **S3** | `cleanup_*.py` 三个不进 dev/，升级为 `mailagent admin cleanup {syncstore, duplicates}` / `repair-parents` | §4.8 / §9.1 |
| **S4** | `compare_llm_path.py` 升级为 `mailagent llm compare-paths`（v4 rollout 质量闸，至少保留到 SQLite 路径稳定一个 release window） | §4.4 / §9.1 |
| **S6** | Typer pin 上限 `>=0.12,<0.14`；rich 同样 pin；补 `tests/cli/test_typer_help_snapshot.py` | §6.5 |
| **S7** | Python 版本口径统一：`requires-python = ">=3.9"`（package），CLI tested on 3.11+（开发版本）。RFC TL;DR 不再单方声明 3.11+ | §6.5 |
| **S8** | `notion list-orphans` 拆三类：`notion page-orphans` / `notion file-link-audit` / `attachment cleanup-orphans` 各司其职 | §4.6 |

### v2 暂不吸纳（留 V2 / 独立 RFC）

| Codex 编号 | 反馈 | 理由 |
|---|---|---|
| **S1** | 加 `mailagent search email` / `email attachments <id>` alias | 主风格已对齐 gh / kubectl；alias 系统留 V2，避免 PR-2 scope creep |
| **S5** | gh 风格 `--json fields --jq` 字段筛选 | 留 V2，PR-2 不实现完整 jq；可在 §12 待定项备注 |

### v2 没列入 Codex 反馈但顺手做的小修

- §1 TL;DR 顶部加 v1→v2 主要变更摘要
- §3 章节表加 backend review 编号映射，便于回溯
- §10 PR-1 / PR-4 预估时间上调（PR-1 1.5d → 2-3d，PR-4 2d → 3d）

---

> **本 RFC v2** 由 Claude Code Opus 4.7 (1M context) 在 2026-05-16 完成。
> v1 → v2 经 Codex GPT-5.5 highest-effort review 反馈吸纳。
> 等待用户 ack 后进入 PR-1 实施（见 §13 / §10）。
