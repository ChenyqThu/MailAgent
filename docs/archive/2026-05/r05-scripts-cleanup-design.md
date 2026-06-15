# R-05: `scripts/` 大扫除设计

> **状态**: 设计稿（2026-05-16）— 等 PR-5（`scripts/*` inline 化 + thin wrapper）合后落地。
> **作者**: Claude Opus 4.7 (1M context) — 与 backend-review-2026-05.md §6 R-05 对齐，补 PR-5 PRD（`prd.json`）未覆盖的细节。
> **前置阅读**: [`backend-review-2026-05.md`](./backend-review-2026-05.md) §6 R-05 + §7 D2、[`archive/pr5-handoff-scripts-migration.md`](./archive/pr5-handoff-scripts-migration.md)（PR-6 起归档）、`prd.json` 12 stories。
> **不在范围**: 不动 `src/`，不动 `scripts/`（PR-5 并行在跑），不删任何文件。仅产出 markdown 设计。

---

## 0. TL;DR

`scripts/` 当前 **45 个文件**（42 `.py` + 3 `.sh`），混杂 8 类。本设计：

1. **对齐 PR-5 PRD** 的 12 个 user stories：US-001..009 inline 化 + US-010 thin wrapper + US-011 archive 子目录。
2. **补 PR-5 PRD 未覆盖的逐脚本归宿**：`prd.json` US-010 写了 "scripts/*.py 全部改 thin wrapper"，但**没有给单脚本的目标命令映射表**（`poc_markdown_api.py` 该归哪、`keep_alive.py` daemon 不是 CLI 应保留顶层等）。本文档给出**全 45 个脚本逐个归宿表**（§3）。
3. **给 post-PR-5 时序**：PR-6 删 thin wrapper 时哪些 doc reference 必须同步改、哪些 import 路径会断（§5）。
4. **不冲突保证**：所有动作都在 PR-5 prd.json 范围内或扩展，不触发 src/* 修改 — 等 PR-5 ship 后再做。

落地时机：**PR-5 ship 之后**（commits 12 个完成、pytest ≥ 650 passed）。本文档作为 PR-5 落地的 reference 表，以及 PR-6 cleanup PR 的 input。

---

## 1. 现状盘点（2026-05-16）

### 1.1 文件数量

```bash
$ ls scripts/*.py scripts/*.sh | wc -l
45      # 42 .py + 3 .sh
```

backend-review-2026-05.md §0 说 "47 个文件"是 review 时点 ballpark（review 文档自己 §1 备注偏差）；当前实测 45 是更准的基线。

### 1.2 引用边界（PR-5 落地必须考虑）

| 引用源 | 引用形式 | 引用次数 | 处置 |
|---|---|---|---|
| `CLAUDE.md` | shell 命令 `python3 scripts/...` | ~15 处 | PR-5 US-012 同步更新 |
| `AGENTS.md` | shell 命令（Codex 入口指南） | 数处 | PR-5 US-012 同步更新 |
| `docs/*.md` | 文档引用（PR handoff、phase 报告、architecture）  | 345 行 | PR-5 US-012 文档段 + PR-6 全量改 |
| `main.py:143` | `sys.path` 加 `scripts/` 以便 import | 1 处 | **重要** — 见 §4.3 风险，PR-5 US-003 必须保留 import 路径或换 module 名 |
| `src/mail/sync_store.py:174` | 错误消息提示 `python3 scripts/migrate_sync_store_v3.py` | 1 处 | PR-5 US-011 archive 后改为 `scripts/archive/migrate_sync_store_v3.py` |
| `src/cli/commands/*.py` | hint / docstring / subprocess.run 透传 | 8+ 处 | PR-5 US-001..004 inline 化时一并清掉 |
| `src/events/handlers.py` | 引用 `scripts/create_reply_draft.sh` + `scripts/html_clipboard.py` | 数处 | 保留（这两个是 helper，不在 CLI 范围） |
| `webhook-server/` | 无引用 | 0 | 无影响 |
| `tests/cli/test_backfill.py` | `mock subprocess.run` 期望 `scripts/...` | 数处 | PR-5 US-001 改 mock 内部函数 |
| `src/` 真实 Python `import scripts.*` | **零** | 0 | scripts/ 不是 package，没有正经 import — 解耦良好 |

**关键发现**：`scripts/` 跟 `src/` 之间**没有正向 Python import**（除了 main.py:143 一个 sys.path hack）。这意味着 PR-5 inline 化只需要把 **scripts 的逻辑搬进 src/cli/**，逆向上 `src/` 完全独立于 `scripts/`，**没有循环依赖风险**。

### 1.3 PR-5 prd.json 进度

```
US-001..US-012 — 全部 passes: false
baseline commit: 76abc45（I-07 refactor 后；当前 main HEAD 9318ab7 是 I-07 docs 更新）
约束: pytest ≥ 650 passed（PR-4 612 + PR-5 ≥ 38）
```

PR-5 还未开工。本设计与 PR-5 计划完全对齐，作为 PR-5 内部 reference + 后续 PR-6 cleanup 输入。

---

## 2. 设计原则

按用户协作教训（CLAUDE.md "目标驱动执行" + "精准修改"）：

1. **不破坏入口契约**: `python scripts/foo.py` 必须仍可调（thin wrapper 4 周 deprecation window）。
2. **逐脚本归宿可追溯**: 每个 .py / .sh 文件**明确**去哪、为什么去。
3. **零循环依赖**: 维持 `src/` 不依赖 `scripts/*` 现状。`scripts/` 是 `src/` 的消费者。
4. **PR-6 删 wrapper 时无 surprise**: 现在就写好 PR-6 要改的 doc reference 清单。
5. **保留生产 daemon / helper**: `keep_alive.py` (saver daemon) / `create_reply_draft.sh` (Mail.app AppleScript bridge) / `deploy-webhook.sh` (远程部署) **不归 CLI 范畴**，不动。
6. **PoC / 证据脚本特殊保留**: `poc_markdown_api.py` 是 T-01 取消的实证依据，归档但不删（docs/notion_markdown_api.md L? 引用）。

---

## 3. 完整 45 脚本归宿表

> **图例**:
> - **PR-5 处置**：PR-5 内部动作。`US-XXX` 引用 `prd.json` 的 user story id。
> - **目标路径**：PR-5 完成后该脚本的物理位置 + 内容形式。
> - **PR-6 处置**：4 周后删 wrapper 时该脚本最终命运。

### 3.1 类 A — 核心生产 CLI 入口（13 个 → thin wrapper）

| # | 脚本 | 当前用途 | PR-5 处置 | 目标路径 | PR-6 处置 |
|---|---|---|---|---|---|
| 1 | `initial_sync.py` | 78KB / 7 sub-action 初始化同步 | **US-003** inline 7 sub-action 到 `src/cli/commands/init.py`；保留 module 让 CLI import + thin wrapper entry | `scripts/initial_sync.py` thin wrapper → `mailagent init <action>` | 删 wrapper；保留 module（CLI 仍 import） |
| 2 | `backfill_email_body.py` | v4 历史正文 backfill | **US-001** inline 逻辑 + LongTaskContext + thin wrapper | thin wrapper → `mailagent backfill body` | 删 wrapper |
| 3 | `backfill_derivatives.py` | v4 衍生附件 backfill | **US-001** inline + thin wrapper | thin wrapper → `mailagent backfill derivatives` | 删 wrapper |
| 4 | `sync_project_progress.py` | 项目周报同步 | **US-002** inline 到 `src/cli/commands/project_progress.py` + thin wrapper | thin wrapper → `mailagent project-progress sync` | 删 wrapper |
| 5 | `cleanup_syncstore.py` | SyncStore 清理 | **US-004** inline 到 `admin cleanup-syncstore` + thin wrapper | thin wrapper → `mailagent admin cleanup-syncstore` | 删 wrapper |
| 6 | `cleanup_duplicate_message_ids.py` | Notion 重复 message_id 清理 | **US-004** inline 到 `admin cleanup-duplicates` + thin wrapper | thin wrapper → `mailagent admin cleanup-duplicates` | 删 wrapper |
| 7 | `cleanup_notion_db.py` | Notion DB 修复（去重 + Parent Item） | **US-004** inline 到 `admin repair-parents` + thin wrapper | thin wrapper → `mailagent admin repair-parents` | 删 wrapper |
| 8 | `compare_llm_path.py` | LLM 双路径对比（Phase 2 一致性验证） | **US-005** 真实现：内联到 `src/cli/commands/llm.py` `compare-paths`（默认 dry-run + `--yes` 实跑） | thin wrapper → `mailagent llm compare-paths` | 删 wrapper |
| 9 | `resync_notion.py` | v4 Phase 4 Notion 重传 | **US-010** thin wrapper（已有 `email resync` PR-2 ship） | thin wrapper → `mailagent email resync` | 删 wrapper |
| 10 | `run_llm_on_email.py` | LLM CLI（selftest / dry-run / force / no-overwrite） | **US-010** thin wrapper（已有 `llm run` + `llm selftest` PR-3 ship） | thin wrapper → `mailagent llm <run\|selftest>` | 删 wrapper |
| 11 | `replay_recurring_invite.py` | 历史会议邀请回放 | **US-010** thin wrapper（已有 `calendar recurring replay` PR-3 ship） | thin wrapper → `mailagent calendar recurring replay` | 删 wrapper |
| 12 | `manual_sync.py` | 手动 ad-hoc 同步（小工具） | **US-010** thin wrapper（需在 PR-5 决定 group 归宿：建议 `mailagent debug manual-sync`） | thin wrapper → `mailagent debug manual-sync` | 删 wrapper |
| 13 | `export_email_content.py` | 导出邮件正文（dev/debug 用） | **US-010** thin wrapper（建议归 `mailagent email body --format raw --save-to PATH`，已有 `email body` PR-2 ship） | thin wrapper → `mailagent email body --save-to PATH` | 删 wrapper |

**13 个核心生产入口**，PR-5 完成后**全部走 mailagent CLI 单入口**。

> **注 13** `export_email_content.py` 当前没有 1:1 等价（`email body --save-to` 输出 markdown/html/raw 三种，但脚本可能输出 .eml 文件）。PR-5 US-010 实施时需 verify 等价性；不等价则**保留 inline 在 `src/cli/commands/email.py`**。

### 3.2 类 B — dev/debug 一次性工具（12 个 → `scripts/dev/`）

PR-5 **US-010** "scripts/check_*.py / test_*.py / 一次性 migration / dev-only utilities git mv 到 scripts/dev/"。

| # | 脚本 | 当前用途 | PR-5 处置 |
|---|---|---|---|
| 1 | `check_duplicate_message_ids.py` | 一次性 Notion 重复检查（diagnostic only） | `git mv scripts/dev/` |
| 2 | `check_inline_images.py` | 检查邮件 cid 引用 | `git mv scripts/dev/` |
| 3 | `check_missing_ids.py` | 检查缺失 row_id / conversation_id | `git mv scripts/dev/` |
| 4 | `check_notion_database.py` | Notion DB schema 检查 | `git mv scripts/dev/` |
| 5 | `check_special_chars.py` | 邮件特殊字符检查 | `git mv scripts/dev/` |
| 6 | `debug_conversion.py` | HTML 转换调试 | `git mv scripts/dev/` |
| 7 | `debug_eventkit.py` | EventKit 原始数据查看 | `git mv scripts/dev/` |
| 8 | `debug_full_children.py` | Notion children blocks 调试 | `git mv scripts/dev/` |
| 9 | `debug_mail_structure.py` | Mail.app account/mailbox 探查 — **已被 `mailagent debug mail-structure` 覆盖** | `git mv scripts/dev/`（CLAUDE.md L188 / L729 reference 改成 `mailagent debug mail-structure`） |
| 10 | `debug_notion_payload.py` | Notion 写入 payload 调试 | `git mv scripts/dev/` |
| 11 | `inspect_all_unread.py` | 扫所有未读邮件 | `git mv scripts/dev/` |
| 12 | `inspect_latest_email.py` | 看最新一封 | `git mv scripts/dev/` |

**12 个**。PR-5 US-010 完成后这些在 `scripts/dev/`，**不再是 production CLI 入口**，开发者随时可 `python scripts/dev/check_inline_images.py` 跑。

> **CLAUDE.md 调整**: L188 / L729 `python3 scripts/debug_mail_structure.py` 改成 `mailagent debug mail-structure -o text`（CLI 已有等价命令）。L186-188 整段 "测试" 子节统一推荐 mailagent CLI。

### 3.3 类 C — 旧式 `test_*.py`（11 个 → `scripts/dev/`）

这些是 pytest 之前年代的 ad-hoc 验证脚本，**不是 pytest 用例**（`tests/` 才是真单测）。

| # | 脚本 | 当前用途 | PR-5 处置 |
|---|---|---|---|
| 1 | `test_attachments.py` | 附件下载测试 | `git mv scripts/dev/` |
| 2 | `test_eventkit.py` | EventKit 性能测试（pyobjc） | `git mv scripts/dev/` |
| 3 | `test_fake_content_type.py` | Notion API content-type 绕过测试 | `git mv scripts/dev/` |
| 4 | `test_keep_alive.py` | 保活脚本人工测试（CLI 4 sub-action） | `git mv scripts/dev/`（保留：keep_alive.py 同伴） |
| 5 | `test_mail_reader.py` | Mail reader 性能验证（一次性 v3 验证） | `git mv scripts/dev/`（**CLAUDE.md L187 改引用**） |
| 6 | `test_notion_api.py` | Notion API 连接测试（一次性 verify） | `git mv scripts/dev/`（**CLAUDE.md L186 改引用**） |
| 7 | `test_office_converter.py` | Office 转换测试 | `git mv scripts/dev/` |
| 8 | `test_remote_unlock.py` | Mac CGEventPost 远程解锁测试 | `git mv scripts/dev/` |
| 9 | `test_subitem_relation.py` | Notion Sub-item relation 测试 | `git mv scripts/dev/` |
| 10 | `test_table_conversion.py` | HTML 表格 → Notion table block 测试 | `git mv scripts/dev/` |
| 11 | `test_v3_architecture.py` | v3 架构实现验证（commit-time test） | `git mv scripts/dev/` |

> **CLAUDE.md "命令速查" 子节**（L184-188）应改写为：
> ```bash
> # 服务连通性自检（PR-3 起 mailagent CLI 覆盖）
> mailagent admin health -o json
> mailagent llm selftest -o json
> mailagent debug mail-structure -o text
> ```

### 3.4 类 D — 一次性 migration（3 个 → `scripts/archive/`）

PR-5 **US-011** "scripts/archive/ 整理一次性 migration 脚本"。

| # | 脚本 | 当前用途 | 最后接触 commit | PR-5 处置 |
|---|---|---|---|---|
| 1 | `migrate_sync_store_v3.py` | v2→v3 schema migration | bf576d1 (v3 ship) | `git mv scripts/archive/` |
| 2 | `backfill_internal_id.py` | 修异常 internal_id（v3 之前的 hash 编码） | d328534 | `git mv scripts/archive/` |
| 3 | `backfill_notion_id.py` | 修 Notion 页面 ID 字段（一次性） | 599666d (notion-client 升级 2.2.1→3.0.0 后的修复) | `git mv scripts/archive/` |

**3 个**。PR-5 US-011 验收要求新建 `scripts/archive/README.md` 写明 "历史一次性脚本，仅供参考，不能直接跑（schema 已变）"。

> **`src/mail/sync_store.py:174`**: 错误消息 `python3 scripts/migrate_sync_store_v3.py` 改成 `python3 scripts/archive/migrate_sync_store_v3.py`（PR-5 US-011 同步改）。

### 3.5 类 E — 长跑服务 daemon（1 个 → 保留顶层）

| # | 脚本 | 当前用途 | PR-5 处置 |
|---|---|---|---|
| 1 | `keep_alive.py` | 防锁屏保活 daemon（CLI 4 sub-cmd：daemon/start/stop/status） | **保留 `scripts/keep_alive.py` 顶层不动** — 不是 mailagent CLI 范畴，是独立 daemon |

理由：`keep_alive.py` 不属于"mail 同步"功能域，是辅助 daemon（MDM 反锁屏）。归 `mailagent` CLI 不合适（命令树会变 noise）。

### 3.6 类 F — Shell helper（3 个 → 保留顶层）

PR-5 prd.json US-010 acceptance criteria 明确："scripts/*.sh (deploy/toggle 等) 保留顶层 不动"。

| # | 脚本 | 当前用途 | 引用方 |
|---|---|---|---|
| 1 | `create_reply_draft.sh` | AppleScript 创建 Mail.app 回复草稿（4 mode：reply-all/reply/new/clipboard-ready） | `src/events/handlers.py:handle_create_draft` |
| 2 | `deploy-webhook.sh` | rsync 部署 webhook-server 到远程 VPS | CLAUDE.md L203 + `scripts/deploy-webhook.sh` 用户手动调 |
| 3 | `toggle_keep_alive.sh` | SIGUSR1 切换保活（macOS 快捷指令绑定） | CLAUDE.md L684 + 用户手动调 |

**保留**。

### 3.7 类 G — Helper module（1 个 → 特殊保留顶层）

| # | 脚本 | 当前用途 | 引用方 |
|---|---|---|---|
| 1 | `html_clipboard.py` | Markdown → HTML → macOS NSPasteboard（5KB Python） | `create_reply_draft.sh --clipboard-ready` + `src/events/handlers.py` |

**保留**。理由：被 `create_reply_draft.sh` 当作 subprocess 调用（`python3 scripts/html_clipboard.py --set-html`），不是 mailagent CLI 范畴。

> **替代方案**（未推荐）: 把 `html_clipboard.py` 搬到 `src/utils/html_clipboard.py`，让 `create_reply_draft.sh` 调 `python3 -m src.utils.html_clipboard`。**不推荐理由**: shell helper 跟 src/ 解耦更清晰；移动反而增加 PYTHONPATH 复杂度。

### 3.8 类 H — PoC / 证据脚本（1 个 → 归档但保留可达）

| # | 脚本 | 当前用途 | PR-5 处置 |
|---|---|---|---|
| 1 | `poc_markdown_api.py` | Notion Enhanced Markdown API file_upload PoC（T-01 取消依据） | **建议** `git mv scripts/dev/poc_markdown_api.py`（dev 类）；`docs/notion_markdown_api.md` 引用路径同步更新 |

理由：`poc_markdown_api.py` 是 T-01 决策的实证依据（commit d1c430d "markdown API file_upload 引用限制 + PoC 脚本"），未来若 Notion API 升级、要重跑 PoC 验证 file_upload 行为变化时还需要它。归 `scripts/dev/` 而非 `scripts/archive/`，因为"实证脚本"性质属于 dev 工具，不是"一次性历史 migration"。

### 3.9 数量验算

| 类 | 数量 | 累计 |
|---|---|---|
| A 核心 CLI thin wrapper | 13 | 13 |
| B dev/debug | 12 | 25 |
| C 旧式 test_*.py | 11 | 36 |
| D 一次性 migration archive | 3 | 39 |
| E 长跑 daemon 保留 | 1 | 40 |
| F shell helper 保留 | 3 | 43 |
| G html helper 保留 | 1 | 44 |
| H PoC 归 dev | 1 | 45 |
| **总计** | **45** | ✓ |

---

## 4. 迁移时序

按 PR-5 prd.json §2.4 的 12 commits 拆分。本设计与之对齐，无新动作。

### 4.1 PR-5 内部时序（12 commits）

```
US-001  Commit 1   backfill body/derivatives inline (类 A.2, A.3)
US-002  Commit 2   project-progress sync inline (类 A.4)
US-003  Commit 3   init 7 sub-action inline (类 A.1)
US-004  Commit 4   admin cleanup-* + repair-parents inline (类 A.5, A.6, A.7)
US-005  Commit 5   llm compare-paths 真实现 (类 A.8) — 注：新增功能 + 内联
US-006  Commit 6   notion page-orphans 真修复
US-007  Commit 7   notion file-link-audit 真修复
US-008  Commit 8   calendar expand 真实现 (抽 src/calendar_notion/expansion.py)
US-009  Commit 9   attachment derive 真 alias
US-010  Commit 10  类 A 剩余 (resync_notion, run_llm_on_email, replay_recurring_invite,
                   manual_sync, export_email_content) 改 thin wrapper +
                   类 B (12) + 类 C (11) + 类 H (1) git mv 到 scripts/dev/
US-011  Commit 11  类 D (3) git mv 到 scripts/archive/ + README.md
US-012  Commit 12  pytest 回归 + CLAUDE.md / AGENTS.md 同步 + PR-5 ship report
```

### 4.2 thin wrapper 模板（PR-5 US-010 沿用）

```python
#!/usr/bin/env python3
"""DEPRECATED — use ``mailagent <new-command>`` instead.

This wrapper will be removed in PR-6 (release window 2-4 weeks after PR-5 ship).
原脚本逻辑已迁到 src/cli/commands/<group>.py.
"""
import sys
import warnings

warnings.warn(
    "scripts/<old_name>.py is deprecated; use 'mailagent <new-cmd>' instead. "
    "Will be removed in PR-6.",
    DeprecationWarning,
    stacklevel=2,
)
from src.cli.main import app
sys.exit(app(["<group>", "<sub>", *sys.argv[1:]]))
```

### 4.3 关键风险点

#### 风险 R1: `main.py:143` `sys.path` hack

`main.py:143` 注释 "添加 scripts/ 到 path 以便导入"。如果 PR-5 US-010 把 scripts 改成 thin wrapper，**该 import 链可能断**。

**缓解**: PR-5 US-003 实施时（initial_sync inline）必须 verify `main.py` 是否真依赖 `from scripts.initial_sync import X`。
- 如是 → 把被 import 的 helper 搬到 `src/`（建议 `src/init/` 子包），更新 `main.py` import 路径
- 如否 → 删 `sys.path` hack

**验证命令**:
```bash
grep -A3 "添加 scripts" main.py
grep -n "^from scripts\|^import scripts" main.py
```

#### 风险 R2: 测试 mock subprocess 失效

`tests/cli/test_backfill.py` 等 PR-4 测试**期望** `subprocess.run` 被调用（mock 断言）。PR-5 US-001 改 inline 后这些 mock 必须改成 mock 内部函数（如 `BackfillRunner.run_for_internal_id`）。

**PR-5 US-001 acceptance criteria 已明确要求**：
> "tests/cli/test_backfill.py 移除 subprocess.run mock 断言; 加 inline partial_failure / max-failures 熔断 unit tests"

无新风险。

#### 风险 R3: CLAUDE.md / AGENTS.md 引用大量过期

CLAUDE.md 引用 `scripts/` 路径 ≥ 30 处（含安装指南 / 命令速查 / 监控章节）。PR-5 US-012 必须**全量改**：
- L186-188 "测试" 段 → 改 mailagent CLI
- L191-193 "初始化同步" → 改 `mailagent init <action>`
- L729 "邮箱名称错误" → 改 `mailagent debug mail-structure`
- L746 → 改 mailagent llm
- L851-906 LLM Agent 章节大量 `python scripts/run_llm_on_email.py` → 改 `mailagent llm run`
- L1078-1094 项目周报章节 → 改 `mailagent project-progress sync`

**估计 CLAUDE.md 改动**: ~50 行 diff（不含格式调整）。

#### 风险 R4: poc_markdown_api 与 docs 引用一致性

`docs/notion_markdown_api.md` 引用 `poc_markdown_api.py`（提供 PoC 执行证据）。PR-5 US-010 把它移到 `scripts/dev/` 后，docs 引用必须同步改：
```
scripts/poc_markdown_api.py → scripts/dev/poc_markdown_api.py
```

#### 风险 R5: webhook-server 引用零（确认）

```bash
grep -rn "scripts/" webhook-server/ → 0 引用
```

webhook-server 是独立部署，**不依赖 scripts/**。PR-5 改动对远程 VPS 部署零影响。

### 4.4 验收（覆盖 prd.json US-012 + 本设计）

PR-5 ship 前必须 ✅：

```bash
# 1. scripts/ 目录布局
ls scripts/ | sort
# 期望顶层: 13 个 thin wrapper .py + 3 个 .sh + keep_alive.py + html_clipboard.py + dev/ + archive/

ls scripts/dev/ | wc -l        # 期望 24 (12 类 B + 11 类 C + 1 类 H poc_markdown_api)
ls scripts/archive/ | wc -l    # 期望 4 (3 .py + README.md)

# 2. thin wrapper 行为
python scripts/initial_sync.py --action fetch-cache --inbox-count 0 --sent-count 0 --yes 2>&1 | head -5
# 期望:  /...DeprecationWarning: scripts/initial_sync.py is deprecated...
#         [实际 inline mailagent init 输出]

# 3. mailagent CLI 等价
mailagent backfill body --dry-run --limit 5 -o json | jq .data.mode
# 期望 "inline" (不再 "subprocess")

# 4. 文档同步
grep -c "python3 scripts/" CLAUDE.md
# 期望 ≤ 5 (仅保留 .sh 引用 + 强制 scripts/ 顶层引用)

# 5. 老脚本调用回归（4 周内必须仍可调）
python scripts/run_llm_on_email.py --selftest 2>&1 | grep DeprecationWarning
# 期望存在

# 6. 单测全过
pytest tests/ -q --tb=no | tail -2
# 期望 ≥ 650 passed (PR-4 612 + PR-5 ≥ 38)

# 7. main.py 启动正常
python -c "import main"
# 期望无 ImportError (验证 R1 风险已缓解)
```

---

## 5. Post-PR-5 路线：PR-6 cleanup

PR-5 ship 后 **2-4 周** deprecation window，然后 PR-6 删 thin wrappers。本节是 PR-6 操作清单的 draft，避免那时再做调查。

### 5.1 PR-6 删除范围（13 个 thin wrappers）

```bash
git rm scripts/initial_sync.py
git rm scripts/backfill_email_body.py
git rm scripts/backfill_derivatives.py
git rm scripts/sync_project_progress.py
git rm scripts/cleanup_syncstore.py
git rm scripts/cleanup_duplicate_message_ids.py
git rm scripts/cleanup_notion_db.py
git rm scripts/compare_llm_path.py
git rm scripts/resync_notion.py
git rm scripts/run_llm_on_email.py
git rm scripts/replay_recurring_invite.py
git rm scripts/manual_sync.py
git rm scripts/export_email_content.py
```

### 5.2 PR-6 文档全量改动清单

| 文件 | 改动 | 行数估计 |
|---|---|---|
| `CLAUDE.md` | 删除所有 `python scripts/<wrapper>.py` 引用；统一用 `mailagent <cmd>` | ~50 行 |
| `AGENTS.md` | 同上 | ~10 行 |
| `docs/agent-cli-rfc.md` | §9 scripts 迁移表标 "completed in PR-5/PR-6" | ~5 行 |
| `docs/LLM_AGENT_SETUP.md` | `scripts/run_llm_on_email.py --selftest` → `mailagent llm selftest` | 2 处 |
| `docs/phase2-complete.md` | T-02 backfill 章节示例命令更新 | 1 处 |
| `docs/phase4-complete.md` | resync 命令示例更新 | 2 处 |
| `docs/initial_sync.md` | 全文档以 `mailagent init` 重写 | ~30 行 |
| `src/cli/commands/admin.py` | 删除 docstring `(subprocess wrap scripts/...)` 描述 | 4 行 |
| `src/cli/commands/llm.py` | 同上 | 5 行 |
| `src/cli/commands/backfill.py` | 同上 | 4 行 |
| `src/cli/commands/init.py` | 同上 | 2 行 |
| `src/cli/commands/attachment.py` | hint 引用 `scripts/backfill_derivatives.py` 改 `mailagent backfill derivatives` | 2 处 |
| `src/cli/commands/email.py` | hint 引用同上 | 2 处 |
| `src/cli/commands/calendar.py` | "走 scripts.replay_recurring_invite" 注释删 | 1 行 |
| `src/mail/sync_store.py:174` | 错误消息 `scripts/migrate_sync_store_v3.py` → `scripts/archive/migrate_sync_store_v3.py` 保留（archive 仍可达） | 1 处（PR-5 已改） |

### 5.3 PR-6 不删的

| 保留项 | 理由 |
|---|---|
| `scripts/keep_alive.py` | 独立 daemon，不在 CLI 范畴 |
| `scripts/html_clipboard.py` | shell helper，被 .sh 调 |
| `scripts/create_reply_draft.sh` | AppleScript bridge，handlers.py 引用 |
| `scripts/deploy-webhook.sh` | 远程部署工具 |
| `scripts/toggle_keep_alive.sh` | 快捷指令绑定 |
| `scripts/dev/*` | 全部保留（开发者工具） |
| `scripts/archive/*` | 全部保留 + README.md 说明 |

### 5.4 PR-6 验收

```bash
# 1. scripts/ 顶层只剩生产 / helper
ls scripts/*.py 2>/dev/null
# 期望: keep_alive.py + html_clipboard.py (2 个 .py)

ls scripts/*.sh
# 期望: create_reply_draft.sh + deploy-webhook.sh + toggle_keep_alive.sh (3 个)

# 2. 老脚本完全断（用户切到 mailagent 完成）
python scripts/run_llm_on_email.py --selftest 2>&1
# 期望: "No such file or directory" 或类似（命令丢失）

# 3. mailagent CLI 所有功能仍 OK
mailagent --help
mailagent admin health -o json | jq .data.healthy
pytest tests/ -q --tb=no | tail -2
# 期望: ≥ 650 passed
```

---

## 6. 与 PR-5 PRD 差异说明

本设计**不冲突 / 不替代** PR-5 PRD（`prd.json` 12 stories）。差异点：

| 维度 | PR-5 prd.json | 本设计 |
|---|---|---|
| 12 stories 实施顺序 | 明确 12 commits | 不再列（直接沿用 PR-5） |
| 单脚本归宿 | "US-010 改 thin wrapper" 一句话覆盖 13 个 | **逐脚本表格化**（§3.1 13 行） |
| dev 子目录列表 | "check_*.py / test_*.py / 一次性 migration / dev-only utilities" 文字描述 | **明确 25 个具体文件**（§3.2 + §3.3 + §3.7 + §3.8） |
| archive 子目录列表 | "scripts/archive_*.py 旧一次性 migration" — 但仓库里**没有 archive_ 前缀文件** | **明确 3 个具体文件**（§3.4，对应 migrate_sync_store_v3 / backfill_internal_id / backfill_notion_id） |
| daemon / helper 处理 | 未提 | **§3.5 + §3.6 + §3.7 明确保留** keep_alive.py / 3 .sh / html_clipboard.py |
| poc_markdown_api.py | 未提 | **§3.8 归 dev** 且 docs 引用同步更新 |
| main.py:143 风险 | 未提 | **§4.3 R1 明确**，PR-5 US-003 必须 verify |
| PR-6 cleanup 范围 | "4 周后删 thin wrappers" 一句话 | **§5 完整清单**（13 git rm + 14 doc 改动） |

**结论**：PR-5 实施时，本设计 §3 表格当 reference 表用；PR-6 实施时，本设计 §5 当作业清单用。两者均与 prd.json 不冲突。

---

## 7. 不在 R-05 范围的相关问题

| 问题 | 现状 | 何时处理 |
|---|---|---|
| `src/mail/sync_store.py:174` 错误消息提示 `python3 scripts/migrate_sync_store_v3.py` | PR-5 US-011 同步改 `scripts/archive/migrate_sync_store_v3.py` | PR-5 |
| `src/cli/commands/*.py` 多处 `subprocess wrap scripts/...` docstring | PR-5 US-001..004 inline 化时一并清掉 | PR-5 |
| `tests/cli/test_backfill.py` 等 mock subprocess.run 断言 | PR-5 US-001 改 mock 内部函数 | PR-5 |
| CLAUDE.md 大量 `python scripts/...` 引用 | PR-5 US-012 同步改 | PR-5 |
| PR-6 删 wrapper 后 docs 全量改动 | 本设计 §5.2 已列清单 | PR-6 |
| webhook-server 远程部署影响 | 零影响（webhook-server 不依赖 scripts/） | 无 |

---

## 8. 决策摘要（给 PR-5 / PR-6 PR 描述用）

- **45 → 13 顶层 thin wrapper + 5 顶层保留 (1 daemon + 3 .sh + 1 html helper) + 24 dev + 3 archive**（按 §3.9 数；合计 13+5+24+3 = 45）
- **不破坏入口**：4 周 deprecation window，老 `python scripts/foo.py` 调用仍返回正确结果（DeprecationWarning + 转发 mailagent CLI）
- **零循环依赖**：`src/` 不依赖 `scripts/`（除 main.py:143 一个 sys.path hack，PR-5 US-003 必须 verify 并清理）
- **CLAUDE.md / AGENTS.md / docs**：~70 行 doc 改动跨 PR-5 + PR-6 两次完成
- **生产部署零影响**：pm2 mail-sync 不引用 scripts；webhook-server 独立部署不引用；唯一影响是用户终端命令习惯

---

> **变更记录**
> - 2026-05-16: 初稿，作者 Claude Opus 4.7 (1M)。基于 PR-5 prd.json + backend-review-2026-05.md §6 R-05 + scripts/ 当前 45 文件 inventory。
> - 待 PR-5 ship 后回看：实际归宿是否符合本设计 §3 表，差异写入 §3 末尾的"实际偏差"段。
