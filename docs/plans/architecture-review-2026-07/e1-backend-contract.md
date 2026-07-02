# E1 — IMailBackend 契约收口 + davmail 上游 watch

> 所属：[架构 Review 2026-07](./README.md) 路线图 Next 阶段。
> 性质：正确性债务偿还（davmail 模式下的 id-space 错配隐患）+ 接口收敛。**不含任何 Graph API / IT 审批相关工作**（见下「范围外」）。

## 1. 背景与目标

Sprint 16 引入 `IMailBackend` Protocol 的目标是「用干净协议替代 AppleScriptArm 宽接口」，实际落地成了相反的形状：

- `DavMailBackend` 用 `self.arm = self` / `self.radar = self` 把自己伪装成 `AppleScriptArm`/`SQLiteRadar`（`src/mail/backend/davmail_backend.py:311-312`，`:701` 注释自述「alias 兼容层」）。
- 全系统的事实契约是「AppleScriptArm 形状的 arm 对象」（`fetch_email_content_by_id` / `mark_as_read_by_id` / `get_new_emails` …），Protocol 定义的方法集大部分无运行时调用方。
- 多个外围入口不经 backend factory，直接构造真 `AppleScriptArm`——davmail 模式下 internal_id ≥ 10⁹（davmail id 空间），打到 Mail.app `whose id is` 必失配。

**目标**：① 契约与现实合一（一个 Protocol、一个实现面、无影子 alias）；② 消灭 backend factory 之外的 `AppleScriptArm()` 直构（除明示 applescript-only 的诊断路径）；③ 落一个 davmail 上游升级 watch 提醒项。

## 2. 现状与证据（2026-07-02 主会话核实）

### 2.1 影子层

| 证据 | 内容 |
|---|---|
| `src/mail/backend/davmail_backend.py:311-312` | `self.arm = self` / `self.radar = self` |
| `src/mail/backend/davmail_backend.py:701` | 注释：「AppleScriptArm.mark_as_read 多形签名 — 让 self.arm = self alias 兼容层」 |
| `src/mail/new_watcher.py:135-155` | 主循环按 backend 分支拿 arm/radar（backend-aware，但拿到的是 arm-compat 面而非 Protocol 面） |

### 2.2 factory 外直构 `AppleScriptArm`（全量对账）

| 调用点 | 场景 | davmail 模式风险 |
|---|---|---|
| `src/sync/job_runners.py:261`（backfill_body）、`:307`（backfill_metadata source=applescript） | **async-jobs 批量执行器**，无 backend guard，无条件直构 | **高**——批量 resync/backfill 对 davmail-space id 走 AppleScript 必失配；这是本 epic 最优先修复点 |
| `src/mail/reverse_sync.py:63` | `arm or AppleScriptArm()` 默认值兜底 | 中——生产由 service 注入正确 arm，但默认值是暗雷；应改为必传 |
| `src/llm_agent/runner.py:119`（+ `src/services/llm_service.py:59` 注释） | davmail probe 失败时 fallback lazy-init AppleScriptArm | 中——davmail 模式下 probe 失败应当失败退避，fallback 到错误 id-space 的 arm 是错配 |
| `src/init/initial_sync.py:238` | 初始化全量同步 | 中——init 流程 davmail 化未完成 |
| `src/project_progress/runner.py:150`、`src/calendar_notion/recurring_invite.py:20,133` | 外挂模块 | 低-中——davmail 主路径下这些模块取信路径需确认 |
| `src/cli/commands/backfill.py:588`（`:335` 注释显示已有 id-space 意识）、`src/cli/commands/llm.py:774` | CLI 批量命令 | 中——CLI 侧部分有注释级 guard，无统一机制 |
| `src/cli/commands/debug.py:68,294` | AppleScript 专项诊断命令 | 无（本来就是 applescript-only 诊断，保留，加注释豁免标记） |

### 2.3 类型面锈蚀

`src/events/handlers.py:19,38`、`src/sync/backfill_builders.py`、`src/sync/mailapp_fanout.py:32` 等处参数类型注解写死 `AppleScriptArm`，实际运行时传入的是 DavMailBackend（靠影子 alias 通过）。

## 3. 方案（推荐 B：把 arm 面正式化为 Protocol）

两个可选方向：

- **方案 A**：把全部调用方迁到现有 Protocol 9 方法。改动面 = 主循环 + handlers + 全部批量路径，diff 大、回归风险高，且 Protocol 现方法集未必贴合真实使用。
- **方案 B（推荐）**：承认现实——把实际被消费的 arm 面（`fetch_email_content_by_id` / `mark_as_read_by_id` / `set_flag_by_id` / `get_new_emails` / `append_draft` / `send_email` / drafts 相关等，以 grep 实际调用为准盘点）正式定义为 `IMailBackend` 的方法集；删掉无人调用的 Protocol 方法；然后删 `self.arm = self` 影子 alias，调用方从 `self.arm.xxx` 改为 `self.backend.xxx`（纯改名级 diff）。

选 B 的理由：契约=现实、diff 最小、一次性消除「两套接口双份实现」，并为未来任何 backend 演进提供真实的接口清单。

### 3.1 实施步骤

**Step 1 — 契约盘点（半天）**
grep 全仓 `\.arm\.` 与 `self\.radar\.` 的方法调用，产出「真实接口清单」表（方法 × 调用方 × 两 backend 是否已实现），落在本目录 `e1-contract-inventory.md`。
验收：清单覆盖 100% 运行时调用；Protocol 现有 9 方法逐个标注 keep/rename/delete。

**Step 2 — Protocol 重定义 + 影子层退役（1-2 天）**
- `src/mail/backend/base.py`（Protocol 定义处）按清单重写方法集；
- `DavMailBackend` / `AppleScriptBackend` 直接实现新 Protocol，删 `self.arm = self` / `self.radar = self`（`davmail_backend.py:311-312`）；
- 调用方 `self.arm.` → `self.backend.`（`new_watcher.py` / `handlers.py` / `reverse_sync.py` / builders），类型注解从 `AppleScriptArm` 改为 `IMailBackend`。
验收：`grep -rn "self\.arm = self" src/` 零命中；`pytest tests/ -q` 全绿；davmail 模式 dogfood 一轮（新邮件抓取 + flag 反向 + 草稿）。

**Step 3 — 外围入口收编 factory（1-2 天）**
- `job_runners.py`：`backfill_body` / `backfill_metadata(source=applescript)` 改为经 `create_backend(cfg)` 取 backend；`source=applescript` 在 davmail 模式下显式报 `ServiceInvalidArgError`（而不是静默构造错误 arm）。
- `reverse_sync.py:63`：删 `or AppleScriptArm()` 默认值，构造参数必传（service 装配点本就注入）。
- `llm_agent/runner.py:119`：davmail 模式 probe 失败 → 抛错进重试/死信，禁止 fallback AppleScriptArm；applescript 模式保留 lazy-init。
- `initial_sync.py` / `project_progress/runner.py` / `recurring_invite.py` / CLI backfill/llm：统一经 factory；`debug.py` 两处加 `# applescript-only diagnostic, factory 豁免` 注释。
验收：`grep -rn "AppleScriptArm(" src --include='*.py' | grep -v backend/ | grep -v applescript_arm.py | grep -v debug.py` 除 `llm_agent/runner.py` 的 applescript 模式 lazy-init（本 Step 上文明示保留的合法 fallback，davmail 模式该路径已改 raise）与注释文案外**零真实构造**；新增单测：davmail 模式下 `run_job(backfill_body)` 取到的 arm 类型为 DavMailBackend；`source=applescript` + davmail 模式报错而非错配。

**Step 4 — davmail 上游 watch 提醒项（半天）**
按用户口径：EWS 2026-10-01 关停的应对 = **跟随 davmail 官方 repo 切 O365 标准接口，项目侧零工程**。只做两件事：
1. `mailagent admin health` 输出加一条静态 note（或 backlog 登记）：「EWS 2026-10-01 关停；2026-08 起关注 davmail release，出新版及时升级 davmail-poc」。
2. 预写 davmail 升级回归清单（本目录 `e1-davmail-upgrade-checklist.md`）：升级步骤（替换 jar / token.dat 迁移确认）+ 回归项（IMAP 收 / SMTP 发 / CalDAV 日历 / OAuth 续期 / `mailagent admin health` 全绿）。

### 3.2 范围外（明确不做）

- ❌ Graph API 自研 backend、Azure 应用注册、IT 审批沟通——与本项目无关。
- ❌ AppleScript fallback 路径下架——EWS 过渡期内它仍是 last-resort，保留（`roadmap-post-cutover.md §4.1` 判据继续适用）。
- ❌ 跨 backend marker 分 key（`roadmap-post-cutover.md §4.3`）——维持「仅一次切换」决策，不做。

## 4. 风险与回滚

| 风险 | 缓解 |
|---|---|
| Step 2 改名波及面大（~10 文件） | 纯机械改名 + 类型检查兜底；分两个 commit（Protocol 重定义 / 调用方改名）便于 bisect |
| davmail 影子 alias 有隐性依赖（多形签名兼容，`davmail_backend.py:701`） | Step 1 盘点时把多形签名差异显式列出，Step 2 统一签名 |
| async-jobs 行为变化（source=applescript 从静默错配变报错） | 报错文案给出正确用法；CHANGELOG 标注 |

回滚：Step 2/3 各自独立 commit，revert 即回。

## 5. 量级与依赖

- 量级：约 3-5 天（含 dogfood）。
- 依赖：无硬前置；建议在 E0（CI 测试闸）就位后做，改动面有网兜着。
- 后续解锁：E2 减法 Sprint 中 outbox 死分支删除会再触碰 handlers——先做 E1 可让那次改动落在干净接口上。

## 6. 实施状态（2026-07-03，trellis `07-03-e1-backend-contract`）

Step 1-4 已全部实施并过独立 check（4 条 implement/check lane），全量 pytest 3313 passed 零排除。关键落地口径：

- **新 Protocol = 17 方法**（真实消费面，非原 9 方法理想面）：probe_readiness + 雷达面 6 + 抓取面 3 + flag 面 4（含 str-fallback 双形）+ append_draft / reconcile_drafts / send_email。`health_status` / `detect_new_emails` 经盘点**零运行时调用方**（base.py 原注释「stats_reporter 定期调」从未接线）→ 连实现体删除；`fetch_email_by_id` / `fetch_recent` 退出 Protocol、DavMail 保留为内部 typed helper。盘点全文见 [`e1-contract-inventory.md`](./e1-contract-inventory.md)。
- **签名统一方向**：mark_as_read / set_flag 取 AppleScriptArm 形状（mailbox 位置可传），DavMail 去 keyword-only——顺带消除 handlers/reverse_sync 位置传参在 davmail 下的 latent TypeError。
- **handlers 双参合并**：`EventHandlers(arm, ..., backend=None)` → `(backend, ...)` 必传（二者本就是同一对象）。
- **收编即修复**：`job_runners.py` backfill 批量路径原本 davmail 模式下直构 AppleScriptArm 必错配 id 空间（本 epic 最优先真 bug）——改走 `deps.backend`（ServiceContext 既有 factory 惰性封装，零新增管线）。
- **probe fail-fast 前移**（授权行为修正的衍生，check 判定方案精神内）：initial_sync / project_progress / CLI backfill·llm 经 factory 后 probe 失败在入口报错，不再静默构造错误 arm。
- **豁免清单**（factory 外合法 AppleScriptArm 直构，仅两处）：`llm_agent/runner.py` applescript 模式 lazy-init（davmail 模式该路径 raise）、`cli/commands/debug.py` ×2（applescript-only 诊断，已加豁免注释）。
- **登记给 E2 的孤儿**：`RadarTick` / `BackendHealth` 类型（tests 在测但生产零消费）、`SyncHealthCheck`（全仓零构造死代码）、`types.py:91` 悬空 docstring 引用。
- Step 4 产出：`admin health` 静态 watch note（JSON `data.notes`，不进 required、不影响 `healthy` 语义）+ [`e1-davmail-upgrade-checklist.md`](./e1-davmail-upgrade-checklist.md)。
