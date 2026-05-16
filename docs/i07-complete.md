# I-07 完成报告（`NotionSync` 拆 5 文件 + `RolloutMetrics` 抽离）

> **Ship commit**: `76abc45` — `refactor(notion): NotionSync 拆 4 文件 + RolloutMetrics 抽离 (I-07)`
> **Docs commit**: `9318ab7` — `docs: CLAUDE.md Notion 模块结构反映 I-07 拆分 + review I-07 标 fixed`
> **Ship 日期**: 2026-05-16（PR-4 ship `4900dda` 后、PR-5 启动前）
> **范围**: `src/notion/sync.py` 单文件 ~1912 行 → 5 文件 2335 行；`RolloutMetrics` 抽到 `src/notion/_common.py` 让 facade ↔ `PageOps` 共享单实例；public API 零改动
> **前置阅读**: [`backend-review-2026-05.md`](./backend-review-2026-05.md) §4 I-07 / §6 R-01（NotionSync strict DI 已在 PR-1 落地，是 I-07 拆分的前置）· [`phase4-complete.md`](./phase4-complete.md) §8（拆分前的 `notion/sync.py` 内部结构 / 行号速查）

---

## 1. TL;DR

`src/notion/sync.py` 在 PR-4 末尾涨到 ~1912 行，承担 5+ 职责（页面 CRUD / Thread relations / Reverse sync 查询 / v4 桥接 / 批量查询 / R-06 v4 rollout 计数）。I-07 把它拆成 5 文件、保 public API 不变、保 R-06 rollout 单实例：

- **5 文件**：`sync.py` 409 (facade) + `pages.py` 1145 + `threads.py` 281 + `queries.py` 378 + `_common.py` 122 = **2335 行**（含必要的 facade delegate + monkeypatch hot-patch + lazy init 兼容 hook，**净增 ~423 行**）
- **共享 RolloutMetrics 实例**：facade `__init__` 创建一份 `RolloutMetrics(sync_store=sync_store)`，传给 `PageOps`。wrapper 灰度路由（在 `PageOps` 内部）和 `admin stats v4_rollout` flush（在 facade）操作**同一对象**，计数不分裂
- **lazy init 兼容**：测试用 `NotionSync.__new__(NotionSync)` 绕 `__init__` 的取巧用法被保留（`_ensure_rollout_counters` + `RolloutMetrics._ensure`）—— PR-4 的 `test_rollout_stats.py` 不改一行
- **612 passed**：拆分前后单测数持平（PR-4 ship 612 → 76abc45 ship 612），public API 11 调用点零改动
- **strict DI 前置**：I-07 能拆是因为 PR-1 已经把 NotionSync 改成 strict DI（必传 `email_repo` + `sync_store`），lazy 创建 EmailRepository 那条死路已消灭

---

## 2. 拆分前后对比

### 2.1 文件清单

| 拆分后路径 | 行数 | 职责 | 拆分前对应位置（约） |
|---|---|---|---|
| `src/notion/_common.py` | 122 | `BEIJING_TZ` 常量 + `CreateEmailFromSqliteResult` dataclass + `RolloutMetrics` class | 散落在 sync.py 顶部常量 + L80-130 RolloutResult dataclass + L132-280 record/snapshot/flush 方法 |
| `src/notion/sync.py` | 409 | `NotionSync` facade：strict DI 构造 + delegate 给 4 个子组件 + 11 个 public API + 20 个 quasi-public `_`-prefix delegate（12 instance + 5 classmethod + 3 staticmethod）+ 11 个 monkeypatch hot-patch entry（8 PageOps + 3 ThreadOps）| 拆分前是同一个 NotionSync 类，但内含所有方法实现 |
| `src/notion/pages.py` | 1145 | `PageOps`：页面 CRUD（`create_email_page_v2` 灰度路由 + `create_email_page_from_sqlite` 主入口 + `sync_email` + helpers）+ Sanitize blocks + v4 SSoT 桥接（cid 还原 + 附件物化 + Email 重建 + file_id 回写 map） | sync.py L300-1500 主要业务 |
| `src/notion/threads.py` | 281 | `ThreadOps`：`handle_thread_relations` + `update_sub_items` + `_find_thread_parent_by_thread_id` + `_find_all_thread_members_with_date` + `_parse_date_to_beijing` | sync.py L1300-1450 |
| `src/notion/queries.py` | 378 | `QueryOps`：批量查询（`query_all_message_ids` / `query_all_row_ids` / `query_pages_for_reverse_sync` / `query_by_row_id`）+ Reverse sync 写入（`update_email_flags` / `update_page_mail_sync_status`）+ `update_parent_item` | sync.py L1500-1700 |
| `src/notion/__init__.py` | 0 | 空 package marker | 拆分前已存在 |

**合计 5 文件 2335 行**（拆分前 ~1912 → 净增 ~423）。

### 2.2 模块依赖（拆分后）

```
                ┌─────────────────────────┐
                │   src/notion/_common.py │  (BEIJING_TZ, CreateEmailFromSqliteResult, RolloutMetrics)
                └───────────▲─────────────┘
                            │ import
       ┌──────────────────┬─┴─┬──────────────────┐
       │                  │   │                  │
       ▼                  ▼   ▼                  ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  threads.py │  │  queries.py │  │   pages.py  │ ── 也 import client.py + html_converter + eml_generator
│  ThreadOps  │  │  QueryOps   │  │   PageOps   │ ── PageOps 持有 RolloutMetrics 实例（由 facade 注入）
└──────▲──────┘  └──────▲──────┘  └──────▲──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │ import (类型 + 构造)
                ┌───────┴────────┐
                │   sync.py      │  (NotionSync facade：__init__ 创建 4 子组件 + delegate)
                │   NotionSync   │
                └────────────────┘
                        ▲
                        │ from src.notion.sync import NotionSync (11 个外部模块)
                        │
        外部模块: src/mail/new_watcher.py / events/handlers.py / mail/reverse_sync.py
                  cli/context.py / cli/commands/email.py / cli/commands/notion.py 等
```

**关键属性**：
- 外部模块**只 import `NotionSync` + `CreateEmailFromSqliteResult` + `BEIJING_TZ`**（仍从 `src.notion.sync` 取，`sync.py` 的 `__all__` 暴露这三个 + `BEIJING_TZ` 透传自 `_common`）
- 4 个子组件（`PageOps / ThreadOps / QueryOps / RolloutMetrics`）属于 internal，不被外部 import
- 子组件之间**无循环依赖**：`PageOps` 用 `ThreadOps`（注入），不反向
- `_common.py` 是 leaf module，无业务依赖

---

## 3. 设计要点

### 3.1 `RolloutMetrics` 抽出 + 共享单实例

**问题**：PR-4 R-06 把 v4 rollout 计数器 (`_route_hit / _route_miss / _route_error / _route_latency_samples / _body_miss_recent`) 加到 NotionSync 实例上。`create_email_page_v2` wrapper 内部分支调 `self.record_route_hit/miss/error`，60s flush loop 调 `self.flush_rollout_stats()` 写 SQLite。如果 wrapper 路由逻辑搬到 `PageOps`，但计数器留在 NotionSync facade 上 → wrapper 调 record 改的是 PageOps 的字段、flush 读的是 facade 的字段，**计数分裂**。

**解决**：`RolloutMetrics` 单独成类，单实例由 facade 持有 + 注入 PageOps（`pages.py:PageOps.__init__(rollout=...)`）。

```python
# src/notion/sync.py:43-48
self._rollout = RolloutMetrics(sync_store=sync_store)
self._pages = PageOps(
    ...
    rollout=self._rollout,
    ...
)
```

- `wrapper 路由`（PageOps 内部）`self._rollout.record_hit(...)` ──┐
                                                                    ├─→ 同一对象
- `flush loop`（facade 调）`self._rollout.flush(sync_store)` ──────┘

### 3.2 lazy init 兼容 `__new__` bypass

**问题**：`tests/notion/test_rollout_stats.py` 用 `NotionSync.__new__(NotionSync)` 绕过 `__init__`，构造一个"空"实例直接测 `record_route_*` / `snapshot_rollout_stats`（不想配置 EmailRepository fixture）。这种用法在 PR-4 是合法的——计数器是 instance attribute，`_ensure_rollout_counters()` 已经做 lazy init。

I-07 拆分后如果直接 `NotionSync.__init__` 在 `self._rollout = RolloutMetrics(...)`，`__new__` bypass 的实例就没有 `_rollout` 属性，所有 `record_route_*` 会 `AttributeError`。

**解决**：两层 lazy init：

```python
# src/notion/sync.py:58-62
def _ensure_rollout_counters(self) -> None:
    """Lazy-init for callers that bypass __init__ via __new__ (tests)."""
    if not hasattr(self, "_rollout"):
        self._rollout = RolloutMetrics(sync_store=getattr(self, "_sync_store", None))
    self._rollout._ensure()
```

```python
# src/notion/_common.py:40-52
class RolloutMetrics:
    def __init__(self, sync_store=None):
        self._sync_store = sync_store
        self._initialized = False  # 真正的 counter init 推迟到 _ensure()

    def _ensure(self) -> None:
        if not getattr(self, "_initialized", False):
            self._route_hit = 0
            self._route_miss = 0
            self._route_error = 0
            self._route_latency_samples: List[float] = []
            self._body_miss_recent: "deque[int]" = deque(maxlen=10)
            self._initialized = True
```

`__init__` 只存 sync_store 引用，**计数器字段不在 `__init__` 里建**——这样 `RolloutMetrics()` 零参实例化也合法（在 `_ensure_rollout_counters` 的 fallback 路径会用 `sync_store=None` 创建）。`record_hit/miss/error/snapshot/flush` 所有入口都先调 `_ensure()`。

**Trade-off**：facade 加 ~30 行 boilerplate（_ensure_rollout_counters + 6 个 @property setter/getter wrapper line 64-112）以保留 1 个测试取巧用法。如果是绿地项目这个 trade-off 不该接受；但这里 PR-4 测试代码不动是硬约束，加 30 行 boilerplate 换零回归风险，合算。

### 3.3 property setter/getter 包装（兼容测试直接 set）

**问题**：`test_rollout_stats.py` 有这样的 pattern：

```python
ns = NotionSync.__new__(NotionSync)
ns._route_hit = 5  # 直接设
ns._route_miss = 2
result = ns.snapshot_rollout_stats()
assert result['from_sqlite_hit'] == 5
```

I-07 拆分后 `_route_hit` 等字段实际存在 `self._rollout._route_hit`。直接 `ns._route_hit = 5` 会**只设 NotionSync 实例属性**，`snapshot()` 读的是 `self._rollout._route_hit`（仍是 0），断言失败。

**解决**：在 facade 加 6 对 `@property` + `@setter`（sync.py L64-112），把这些字段名转发到 `self._rollout`：

```python
@property
def _route_hit(self) -> int:
    self._ensure_rollout_counters()
    return self._rollout._route_hit

@_route_hit.setter
def _route_hit(self, value: int) -> None:
    self._ensure_rollout_counters()
    self._rollout._route_hit = value
```

**收益**：旧测试**零改动**。

**成本**：~48 行 boilerplate（6 字段 × 8 行）。

### 3.4 Monkeypatch hot-patch hook（`_ensure_pages`）

**问题**：PR-3 / PR-4 测试大量用 `monkeypatch.setattr(notion_sync, "_build_properties", fake_fn)` 来 mock 特定 method。拆分后**真正的实现**在 `PageOps`，调用链是 `NotionSync._build_properties` (facade delegate) → `self._ensure_pages()._build_properties` (PageOps) → 真实现。

如果 `notion_sync.__dict__["_build_properties"] = fake_fn` 但 `notion_sync._pages._build_properties` 仍是原版，那么 facade delegate 调 PageOps 拿到的还是原版——monkeypatch 失效。

**解决**：`_ensure_pages()`（sync.py L159-199）在每次返回 PageOps 实例前，**扫 facade `__dict__` 拷贝 8 个 hot-patch method 到 PageOps 实例上**：

```python
# src/notion/sync.py:187-199
for name in (
    "_upload_attachments",
    "_upload_eml_file",
    "_create_page_with_blocks",
    "_build_properties",
    "_build_image_map",
    "_build_children",
    "_handle_thread_relations",
    "_convert_office_attachments",
):
    if name in self.__dict__:
        setattr(self._pages, name, self.__dict__[name])
```

同样的逻辑也在 `_handle_thread_relations` delegate（line 398-406）和 `_ensure_threads`（line 146-151）做了 3 个 thread 相关 method 的 hot-patch（`update_sub_items / _find_all_thread_members_with_date / _parse_date_to_beijing`）。

**收益**：旧测试 monkeypatch 零改动。

**成本**：~30 行 hot-patch hook + 一次 `__dict__` 扫描的微小性能 overhead（每个 delegate 调用都跑一次）。

### 3.5 `_ORIGINAL_CREATE_EMAIL_PAGE_FROM_SQLITE` 类级保存

**问题**：v4 灰度 wrapper 路由（在 PageOps.create_email_page_v2 内）需要调 `create_email_page_from_sqlite`。如果测试 monkeypatch facade 的 `create_email_page_from_sqlite`，wrapper 内部应该走 monkeypatched 版本。

但 PageOps 内部 delegate 是 `self._create_email_page_from_sqlite`（**实例 attribute，不是类 attribute**），需要 facade 把 monkeypatched method 拷过去。

**解决**：facade 在 module 底层（line 409）保存原版引用：

```python
_ORIGINAL_CREATE_EMAIL_PAGE_FROM_SQLITE = NotionSync.create_email_page_from_sqlite
```

`_ensure_pages` 检测 facade 类是否 monkeypatched（line 178-186）：

```python
if (
    "create_email_page_from_sqlite" in self.__dict__
    or
    type(self).create_email_page_from_sqlite
    is not _ORIGINAL_CREATE_EMAIL_PAGE_FROM_SQLITE
):
    self._pages._create_email_page_from_sqlite = (
        self.create_email_page_from_sqlite
    )
```

两种 monkeypatch 形式都覆盖：
- `monkeypatch.setattr(notion_sync, "create_email_page_from_sqlite", fake)`（instance level → in `self.__dict__`）
- `monkeypatch.setattr(NotionSync, "create_email_page_from_sqlite", fake)`（class level → identity 检查）

### 3.6 strict DI 前置（PR-1 R-01 已落地）

I-07 能拆是因为 PR-1 把 `NotionSync.__init__` 改成**必传** `email_repo` + `sync_store`（删 lazy `_ensure_sqlite_resources`）。如果 lazy 那条路径还在，拆 PageOps 时就要决定"PageOps 也带 lazy init 吗"——会让本来就复杂的 facade 进一步翻倍。

PR-1 R-01 + I-07 拆分是配套设计：先把 DI 收敛到入口（PR-1），再做组件拆分（I-07），顺序反了拆分难度会大很多。

---

## 4. Public API 调用点验证

外部模块仍 `from src.notion.sync import NotionSync, CreateEmailFromSqliteResult, BEIJING_TZ`。拆分前后 grep 验证：

```bash
$ grep -rn "from src.notion.sync import\|from src.notion import" src/ tests/ 2>/dev/null
src/mail/new_watcher.py: from src.notion.sync import NotionSync
src/events/handlers.py:  from src.notion.sync import NotionSync
src/mail/reverse_sync.py: from src.notion.sync import NotionSync
src/cli/context.py:      from src.notion.sync import NotionSync
src/cli/commands/email.py: from src.notion.sync import NotionSync
src/cli/commands/notion.py: from src.notion.sync import NotionSync
src/cli/commands/calendar.py: from src.notion.sync import NotionSync
src/cli/commands/admin.py: from src.notion.sync import NotionSync
scripts/resync_notion.py: from src.notion.sync import NotionSync, CreateEmailFromSqliteResult
scripts/initial_sync.py: from src.notion.sync import NotionSync
tests/notion/test_create_from_sqlite.py: from src.notion.sync import NotionSync, CreateEmailFromSqliteResult
（其他 tests/ 同样格式）
```

**11+ 外部 import 调用点**，I-07 拆分**零改动**——`sync.py` 的 `__all__ = ["BEIJING_TZ", "CreateEmailFromSqliteResult", "NotionSync"]` 保留这三个名称的对外导出（`BEIJING_TZ` + `CreateEmailFromSqliteResult` 实际定义在 `_common.py`，由 `sync.py` 顶部 import 后透传暴露）。

外部模块**不**直接 import 子组件（`PageOps / ThreadOps / QueryOps / RolloutMetrics`）——这是 internal 实现细节。

---

## 5. 测试 / 验收

### 5.1 单测数

| 维度 | 拆分前（commit `4900dda` PR-4 ship） | 拆分后（commit `76abc45` I-07 ship） |
|---|---|---|
| pytest 总 passed | 612 | 612 |
| `tests/notion/` 子套件 | 全过 | 全过（含 `test_rollout_stats.py` 10 个 / `test_create_from_sqlite.py` 21 个） |
| 改动的测试文件 | — | **0** — 所有现有测试零改动 |

I-07 的设计目标之一就是**保测试 invariant**。`test_rollout_stats.py` 用 `__new__` bypass + 直接 set `_route_hit` 字段的取巧模式被 `_ensure_rollout_counters` + property wrapper 兼容。

### 5.2 ruff / lint

```bash
$ ruff check src/notion/
（无输出 = 零 issue）
```

### 5.3 行数对比

```bash
$ wc -l src/notion/*.py
       0 src/notion/__init__.py
     122 src/notion/_common.py
     427 src/notion/client.py     # 不在 I-07 范围
    1145 src/notion/pages.py
     378 src/notion/queries.py
     409 src/notion/sync.py
     281 src/notion/threads.py
    2762 total
```

减去 `client.py` 427 + `__init__.py` 0 = **2335 行**（I-07 拆分产物）。

最大文件 `pages.py` 1145 行——仍大但**已突破"单文件难导航"阈值**（原 1912 已经接近 IDE outline 折叠极限）。如果未来要进一步拆 PageOps，可按"v2 路径 / from_sqlite 路径 / sanitize utilities / build_* helpers"四类再切。本轮不做。

---

## 6. Trade-off 分析

### 6.1 收益

| 维度 | 拆分前 | 拆分后 |
|---|---|---|
| 单文件最大行数 | 1912 | 1145 (-40%) |
| 职责分散 | 单类 5+ 职责 | 4 子组件各专一域 |
| 共享 state 实例数 | RolloutMetrics 1 个（PR-4 ship 时就是 1 个，I-07 维持） | RolloutMetrics 1 个（注入 PageOps） |
| 可测性（子组件独立测） | 全靠 NotionSync 整体 fixture | PageOps / ThreadOps / QueryOps / RolloutMetrics 各自可单测 |
| public API 表面 | 不变 | 不变（11+ 外部调用点零改动） |
| 测试代码改动 | — | 0 行（lazy init + property wrapper + hot-patch hook 兼容） |

### 6.2 成本

| 维度 | 额外行数 |
|---|---|
| facade `_ensure_*` 系列 | ~25 行（_ensure_rollout_counters / _ensure_threads / _ensure_queries / _ensure_pages） |
| property setter/getter wrapper（6 字段） | ~48 行 |
| monkeypatch hot-patch hook（8 method × `__dict__` scan + 3 thread method） | ~30 行 |
| `_ORIGINAL_CREATE_EMAIL_PAGE_FROM_SQLITE` 检测 | ~10 行 |
| public API + quasi-public delegate（11 + 20 = 31 个 method） | ~140 行（instance ~5 行 / classmethod / staticmethod ~3 行，加权 ~4.5 行均） |
| Sub-component `__init__` boilerplate | ~50 行（PageOps __init__ 参数列表 + 各 setter） |
| 类型 import / TYPE_CHECKING | ~10 行 |
| **总净增** | **~310 行** facade boilerplate + ~110 行子组件 ctor 重组 = **~423 行** |

净增 423 行换：
- 单文件最大行数从 1912 → 1145（-40%）
- 子组件可独立测
- 共享 state 显式注入（不再隐式）
- 测试零改动

**判断**：合算。如果是绿地项目，~30 行的 `_ensure_rollout_counters` + property wrapper 仅为兼容测试取巧模式肯定不该做；但这里**改测试代码是更大成本**（PR-4 测试套件 14+10+4 = 28 个 case 涉及 rollout / counter，全部测过的代码、还在用），保持现状价值高于代码洁癖。

### 6.3 不做的事

- **不**进一步拆 `PageOps` 1145 行——目前可读，分支边界清晰（v2 / from_sqlite 两条主线 + 共享 helper），拆得更细 facade boilerplate 会再翻倍
- **不**改 public API name 或 signature——任何 rename 会让 11+ 外部调用点跟拆分耦合，违反"一次只做一件事"
- **不**清理 `_save_email_compat` 等其他 Active issue（I-12）——它们在 `sync_store.py`，不在本次拆分范围

---

## 7. 关键文件入口速查

### I-07 新增 / 修改
- `src/notion/_common.py` 全文 — `BEIJING_TZ` + `CreateEmailFromSqliteResult` + `RolloutMetrics`
- `src/notion/sync.py:20-56` — `NotionSync` 类签名 + `__init__` strict DI + 4 子组件构造
- `src/notion/sync.py:58-145` — 兼容 lazy init: `_ensure_rollout_counters` + 6 个 property setter/getter + 5 个 rollout public method delegate
- `src/notion/sync.py:146-199` — 4 个 `_ensure_*` getter（含 PageOps hot-patch hook）
- `src/notion/sync.py:201-283` — 11 个 public API delegate
- `src/notion/sync.py:285-406` — 20 个 quasi-public `_`-prefix delegate（12 instance + 5 classmethod + 3 staticmethod；含 `_handle_thread_relations` 的 ThreadOps hot-patch 复制）
- `src/notion/sync.py:409` — `_ORIGINAL_CREATE_EMAIL_PAGE_FROM_SQLITE` 类级 sentinel（monkeypatch 检测）
- `src/notion/pages.py` — `PageOps` 新类（拆出 1145 行业务）
- `src/notion/threads.py` — `ThreadOps` 新类（281 行 thread relations）
- `src/notion/queries.py` — `QueryOps` 新类（378 行批量查询 + reverse sync 写入）

### CLAUDE.md 同步段
- "Notion 模块（`src/notion/`）" 子节（commit `9318ab7`）：列出 5 文件 + 行数 + 各文件职责一句话

### 不动的
- `src/notion/client.py`（NotionClient API 封装层，427 行）— 不在 I-07 拆分范围
- 11+ 外部 import 调用点全部不动

---

## 8. 与 PR-5 / 后续工作的关系

I-07 ship 时机选在 **PR-4 ship 后、PR-5 启动前**，原因：

| 关系 | 说明 |
|---|---|
| 不阻塞 PR-5 | PR-5（scripts/* inline + thin wrapper）改的是 `src/cli/commands/*` + `scripts/*`，不动 `src/notion/`。两边解耦 |
| 给 PR-5 内联实现做铺路 | PR-5 US-006（`notion page-orphans` 真修复）、US-007（`notion file-link-audit`）会**直接调子组件** —— PR-5 可以选择 `from src.notion.queries import QueryOps` 短路，或者仍走 facade（推荐后者，保接口稳定） |
| Phase 5（未来 Web/Electron 前端）受益 | 前端可能要独立 import `QueryOps` 做只读查询，不需要拽整个 NotionSync (with EmailRepository) |
| T-01（Notion sync 迁 Markdown API，已取消）若解禁，PageOps 是改动点 | T-01 在 2026-05-15 commit `d1c430d` 正式取消（markdown API 不能承载 file_upload）。若未来解禁，PageOps 内的 `_build_children` 是重写入口 |

I-07 与 backend-review §9 audit 配套交付：本次 review 已把 I-07 从 ⚠ Active 改标 ✅ Fixed。

---

## 9. 后续清理 backlog

I-07 拆分留下的可选 follow-up（**不阻塞任何工作**）：

1. **PageOps 进一步拆分**：如果未来 `pages.py` 又涨到 1500+ 行，可按 v2 / from_sqlite / helpers 三分。当前 1145 行可读，**不做**
2. **monkeypatch hot-patch 收敛**：~30 行 hot-patch hook 是为兼容测试取巧用法，未来如果整理 `tests/notion/` 改成 fixture 注入风格，可一并删掉。**优先级低**
3. **`_ORIGINAL_CREATE_EMAIL_PAGE_FROM_SQLITE` 死代码风险**：仅当所有测试都不再做 class-level monkeypatch 时可删；当前 `tests/notion/test_create_from_sqlite.py` 还在用 → **保留**

---

> **新 session 接手指令**：
>
> I-07 已 ship（commit `76abc45` + docs `9318ab7`）。`src/notion/` 当前布局 5 文件 2335 行，public API 11 调用点不变。
>
> 进入 PR-5 实施 / 后续 Notion 模块改动前，建议读本文档 §3（设计要点）和 §6（trade-off）：
> 1. 改 `pages.py` 时注意 hot-patch hook（_ensure_pages 内 `__dict__` 扫描）——加新 method 时如果想被测试 monkeypatch 就要加进 hot-patch 列表
> 2. 改 RolloutMetrics 时记得保 `_ensure()` lazy init 模式，否则 `__new__` bypass 测试会断
> 3. 外部模块加新调用，仍 `from src.notion.sync import NotionSync, ...`——**不要**直接 import 子组件

---

> 本报告由 Claude Code Opus 4.7 (1M context) 完成于 2026-05-16（与 backend-review §9 audit 同日）。仅产出 markdown，不动代码、不动 git。
