# E1 Step 1 — IMailBackend 契约盘点（arm/radar 真实消费面）

> 盘点日期：2026-07-03（Lane A，全部 file:line 现场核实）。
> 结论服务于 [e1-backend-contract.md](./e1-backend-contract.md) 方案 B：把「实际被消费的 arm 面」正式化为 `IMailBackend` Protocol，删影子 alias。

## 1. 表 1 — 真实接口清单（方法 × 调用方 × 两侧实现 × 签名差异）

「AppleScriptArm 侧」= `src/mail/applescript_arm.py`（davmail 模式下由 `DavMailBackend` 的 arm-compat 兼容层同名方法顶替）；「DavMail 侧」= `src/mail/backend/davmail_backend.py`。行号为盘点时值。

### 1.1 arm 面（邮件抓取 / flag 写 / 草稿）

| 方法 | 运行时调用方（file:line） | AppleScriptArm | DavMailBackend | 签名差异 |
|---|---|---|---|---|
| `fetch_email_content_by_id(internal_id, mailbox=None) → Optional[dict]` | `new_watcher.py:696,1329,1361,1374`（位置传 mailbox）· `events/handlers.py:1112` · `sync/backfill_builders.py:234,680` · `llm_agent/runner.py:169` · `project_progress/runner.py:788` · `calendar_notion/recurring_invite.py:155` · `cli/commands/email.py:1660`（经 `cli.backend.arm.`）· `init/initial_sync.py:1061,1122,1476` | `:701` | 兼容层 `:1051`（委托 typed `fetch_email_by_id` → `to_legacy_dict()`） | 无 |
| `fetch_email_by_message_id(message_id, mailbox=None) → Optional[dict]` | `init/initial_sync.py:607,1063,1124,1211,1252,1478`（Lane C 域，直构 arm 上调用） | `:656` | 兼容层 `:1058` | 无 |
| `fetch_emails_by_position(count, mailbox=None) → list[dict]` | `applescript_backend.py:154`（fetch_recent 内部）· `init/initial_sync.py`（经私有 `_fetch_emails_from_applescript`，见 §5.3） | `:95` | 兼容层 `:1086`（委托 fetch_recent） | 无 |
| `mark_as_read_by_id(internal_id, read=True, mailbox=None) → bool` | `mail/reverse_sync.py:314` · `events/handlers.py:239,313,319,524` · `sync/mailapp_fanout.py:78`（to_thread 位置传参） | `:463` | 兼容层 `:1101` | 无 |
| `set_flag_by_id(internal_id, flagged=True, mailbox=None) → bool` | `mail/reverse_sync.py:323` · `events/handlers.py:249,314,523` · `sync/mailapp_fanout.py:86` | `:503` | 兼容层 `:1107` | 无 |
| `mark_as_read(message_id, read=True, mailbox=None) → bool`（str fallback） | `mail/reverse_sync.py:315` · `events/handlers.py:241,527`（全部**位置传 mailbox**） | `:379`（`message_id: str`，mailbox 位置可传） | `:693`（`identifier: Union[int,str]`，**mailbox keyword-only**） | **多形差异 ①**（见 §3） |
| `set_flag(message_id, flagged=True, mailbox=None) → bool`（str fallback） | `mail/reverse_sync.py:324` · `events/handlers.py:251,526` | `:421` | `:708`（同上 keyword-only） | 同 ① |
| `reconcile_drafts() → tuple[list[dict], list[int]]` | `new_watcher.py:570`（`hasattr` duck-typed，davmail-only） | **无**（hasattr False → noop） | `:1452` | **多形差异 ②**（见 §3） |
| `append_draft(draft: DraftRequest) → DraftAppendResult` | `events/handlers.py:813`（`self.backend.`）· `services/mail_write.py:1504`（`self._ctx.backend.`） | AppleScriptBackend `:175`（sh 委托） | `:817` | 无（本来就是 Protocol 面） |
| `send_email(draft: DraftRequest) → SendResult` | `services/mail_write.py:1691` | AppleScriptBackend `:258` | `:876` | 无（同上） |
| `probe_readiness() → tuple[bool, str]` | `backend/factory.py:67` | AppleScriptBackend `:63` | `:348` | 无 |

### 1.2 radar 面（雷达 / marker）

调用方全部在 `new_watcher.py`（davmail 模式下 `self.radar = backend.radar = backend`）。

| 方法 | 运行时调用方 | SQLiteRadar | DavMailBackend | 差异 |
|---|---|---|---|---|
| `is_available() → bool` | `new_watcher.py:149,320,460,1460` | ✓ | 兼容层 `:1130`（TCP probe） | 无 |
| `get_current_max_row_id() → int` | `new_watcher.py:366` · `applescript_backend.py:71`（probe 内部） | ✓ | 兼容层 `:1135`（UIDNEXT） | 无 |
| `check_for_changes(last_max_row_id) → (bool,int,int)` | `new_watcher.py:462` | ✓ | 兼容层 `:1203` | 无 |
| `get_new_emails(since_row_id) → list[dict]` | `new_watcher.py:471` | ✓（keyword `since_row_id=`） | 兼容层 `:1256` | 无（两侧参数名一致） |
| `set_last_max_row_id(row_id) → None` | `new_watcher.py:362,367` | ✓ | 兼容层 `:1819`（内存缓存） | 无 |
| `get_last_max_row_id() → int` | `new_watcher.py:1459` | ✓ | 兼容层 `:1823` | 无 |

### 1.3 盘点到但**无运行时调用方**的兼容面（本次删除）

| 成员 | 位置 | 判定依据 |
|---|---|---|
| `DavMailBackend.extract_thread_id` | `davmail_backend.py:1113` | 全仓 `\.extract_thread_id(` 仅 `applescript_arm.py:684,879`（arm 内部自用）——兼容层零消费 → **删** |
| `DavMailBackend.db_path = None` | `davmail_backend.py:314` | `radar\.db_path` 消费仅 `applescript_backend.py:82`（health_status 内部，随 health_status 删）与 `reverse_sync.py:304`（**直构** SQLiteRadar 上，非 backend 面）→ **删** |
| `SQLiteRadar.get_all_valid_row_ids` 的 backend 面需求 | `mail/health_check.py:43` | `SyncHealthCheck` 全仓**零构造点、零 import**（死代码）→ 不进 Protocol；health_check.py 留待 E2 减法处置 |
| `AppleScriptArm.get_stats` / `._stats` | `applescript_backend.py:83` | `_stats` 仅 health_status 消费（随删）；`arm.get_stats` 零调用 → 不进 Protocol |

## 2. 表 2 — Protocol 旧 9 方法逐个判定（`src/mail/backend/base.py`）

| 旧方法 | 运行时调用方 | 判定 | 说明 |
|---|---|---|---|
| `probe_readiness` | factory.py:67 | **keep** | 启动 probe 契约 |
| `health_status` | **零**（注释称 stats_reporter 定期调——从未接线；仅 backend 单测触碰） | **delete** | 两 backend 实现体一并删；`BackendHealth` dataclass 保留在 types.py（tests/mail/backend/test_types.py 在测），孤儿类型登记给 E2 |
| `detect_new_emails` | **零**（watcher 走 radar 面 `check_for_changes`/`get_new_emails`） | **delete** | 两实现体删；`RadarTick` 成孤儿类型，登记给 E2 |
| `fetch_email_by_id` | 零外部（仅 DavMail 内部 `fetch_email_content_by_id → fetch_email_by_id` 委托） | **delete from Protocol** | DavMail 保留同名方法作**内部 typed helper**（含 stale-UID fallback 逻辑）；AppleScriptBackend 实现体删 |
| `fetch_recent` | 零外部（仅 DavMail 内部 `fetch_emails_by_position → fetch_recent` 委托） | **delete from Protocol** | 同上：DavMail 留内部 helper，AppleScriptBackend 实现体删 |
| `mark_as_read` | reverse_sync/handlers 的 str-fallback 分支 | **keep + rename 语义**：签名统一为 str-fallback 面（见 §3 ①） | 主 int 路径由新收编的 `mark_as_read_by_id` 承担 |
| `set_flag` | 同上 | **keep + rename 语义**（同上） | 同上 |
| `append_draft` | handlers.py:813 · mail_write.py:1504 | **keep** | 签名不变 |
| `send_email` | mail_write.py:1691 | **keep** | 签名不变 |

**新收编进 Protocol 的方法**（正式化 arm/radar 面，§1.1/§1.2 全部有真实调用方的行）：
`fetch_email_content_by_id` · `fetch_email_by_message_id` · `fetch_emails_by_position` · `mark_as_read_by_id` · `set_flag_by_id` · `reconcile_drafts` · `is_available` · `get_current_max_row_id` · `check_for_changes` · `get_new_emails` · `set_last_max_row_id` · `get_last_max_row_id`。

新 Protocol 共 17 方法 + `backend_origin` 属性。

## 3. 多形签名统一决策

**① `mark_as_read` / `set_flag`（keyword-only mailbox 错配，latent TypeError）**
- 现状：AppleScriptArm 侧 `(message_id: str, read=True, mailbox=None)`——mailbox **位置可传**；DavMail 侧 `(identifier: Union[int,str], read=True, *, mailbox=None)`——mailbox **keyword-only**（`davmail_backend.py:701` 自述为 alias 兼容层而设）。
- 全部 5 个调用点（reverse_sync:315,324 · handlers:241,251,526,527）都是**三位置参数**调用 → davmail 模式下这些 str-fallback 分支一旦可达即 `TypeError`（当前仅 outbox=off 老路径且 internal_id 缺失时可达，生产 outbox=on 不可达——latent bug）。
- **统一决策**：Protocol 签名取 AppleScriptArm 形状 `(message_id: str, read/flagged: bool = True, mailbox: Optional[str] = None)`（mailbox 位置可传）。DavMail 实现去掉 keyword-only `*`（参数仍容忍 int，内部 `_resolve_record_for_flag_op` 双 dispatch 不变——`mark_as_read_by_id` 委托它传 int）。调用点零改动，latent TypeError 随签名统一消除。

**② `reconcile_drafts`（AppleScript 侧无实现）**
- 现状：davmail-only，watcher 用 `hasattr` duck-typing（`new_watcher.py:567`），AppleScript 模式 hasattr False → noop。
- **统一决策**：进 Protocol；AppleScriptBackend 实现返回 `([], [])`（drafts sync 是 davmail-only 能力，空返回 = watcher 两个 for 循环零迭代 = 与 hasattr-False noop 字节级等价）。watcher 的 hasattr guard 保留（防御 Mock/旧对象，语义不变）。

**③ `fetch_email_content_by_id` 等其余方法**：两侧签名一致（mailbox 位置可传，默认 None），无需统一。

## 4. 影子 alias 的属性消费点（删 alias 时必须一并迁移）

`self.arm = self` / `self.radar = self`（`davmail_backend.py:311-312`）删除后，以下**属性访问**会断，属于组 2 调用方迁移的必要部分（PRD 组 3「调用方迁移 self.arm→backend」）：

| 消费点 | 现状 | 迁移后 |
|---|---|---|
| `new_watcher.py:143-144` | `self.radar = backend.radar; self.arm = backend.arm` | watcher 直接持 `self.backend`，内部 19 处 `self.arm.`/`self.radar.` 全改 `self.backend.` |
| `service.py:136,167,202` | `arm=self.watcher.arm` 传给 fanout/reverse_sync/handlers | 直接传 `self.backend` |
| `llm_agent/runner.py:116-117` | `hasattr(self._backend, "arm")` → `self._arm = self._backend.arm`；**删 alias 后 hasattr False → 静默 fallback AppleScriptArm() = davmail id-space 错配（行为回退，不可接受）** | `self._arm = self._backend`（backend 自身即满足 `fetch_email_content_by_id` 契约）；`:119` 的 AppleScriptArm() fallback 语义不动（Lane C） |
| `cli/commands/email.py:1660`（+`:1487` 注释） | `cli.backend.arm.fetch_email_content_by_id(...)` → davmail 下 AttributeError | `cli.backend.fetch_email_content_by_id(...)` |
| `cli/commands/calendar.py:309` | `arm = cli.backend.arm` | `arm = cli.backend` |
| `cli/commands/backfill.py:337`（+`:333` 注释） | `arm = cli.backend.arm` | `arm = cli.backend` |
| `cli/context.py:134-136` | docstring 描述 `backend.arm` 语义 | docstring 更新 |
| `tests/mail/backend/test_davmail_backend.py:731-733` | `_make_backend` 手动设 `backend.arm = backend` 等 3 行 | 删 |

**不受影响**（拿到的本来就是 backend 对象或直构 arm，非 `.arm` 属性）：`project_progress/runner.py:144-151`（`self._arm = create_backend(...)` 直接存 backend；`:788` 在其上调 `fetch_email_content_by_id`——Protocol 方法，继续可用）· `init/initial_sync.py:238`（直构 AppleScriptArm，Lane C）· `sync/job_runners.py:261,307`（直构，Lane C）。

## 5. Lane C 交接登记（本 lane 只登记不改）

### 5.1 factory 外直构 `AppleScriptArm()`（e1 §2.2 对账 + 本次复核）

| 位置 | 场景 | 复核结论 |
|---|---|---|
| `sync/job_runners.py:261`（backfill_body）`:307`（backfill_metadata source=applescript） | async-jobs 无条件直构 | 仍成立；davmail 模式高风险 |
| `mail/reverse_sync.py:63` | `arm or AppleScriptArm()` 默认值 | 仍成立（Lane A 改名 backend + 类型注解后默认值兜底保留，Lane C 删） |
| `llm_agent/runner.py:119` | probe 失败/无 backend fallback | 仍成立 |
| `init/initial_sync.py:238` | init 全量同步 | 仍成立；另有**私有方法越界**：`:459` 调 `self.arm._fetch_emails_from_applescript(...)` + `self.arm._get_mailbox_name(...)`（连 arm 公开面都不是），Lane C 收编时需一并处理 |
| `project_progress/runner.py:150` | applescript 分支 lazy | 仍成立（davmail 分支已走 factory ✓） |
| `calendar_notion/recurring_invite.py:20,133` | import + 类型注解 AppleScriptArm | 仍成立（`:155` 只调 `fetch_email_content_by_id`，Protocol 兼容） |
| `cli/commands/backfill.py:588` · `cli/commands/llm.py:774` | CLI 批量命令 | 仍成立 |
| `cli/commands/debug.py:68,294` | AppleScript 专项诊断 | 仍成立（Lane C 加豁免注释） |

### 5.2 直构 `SQLiteRadar`（applescript-only 查询路径，非 backend 面，登记备查）

| 位置 | 场景 |
|---|---|
| `mail/reverse_sync.py:303-305` | `_lookup_internal_id` 的 Envelope Index fallback（davmail 模式下查 Mail.app id-space——跨空间隐患同类项） |
| `events/handlers.py:914`（`_get_radar`） | `handle_query_mail(source=mail)` 全量搜索 Mail.app |
| `new_watcher.py:148` | legacy backend=None 分支（本 lane 组 2 改为构造 AppleScriptBackend，见 §6） |

### 5.3 类型注解锈蚀（Lane A 修复范围）

`events/handlers.py:19,38`（`arm: AppleScriptArm`）· `sync/mailapp_fanout.py:32`（docstring）· `sync/backfill_builders.py:33,222,338,665,732` · `mail/reverse_sync.py:32,53`——运行时实际传入 DavMailBackend（靠影子 alias 通过）。本 lane 全部改为 `IMailBackend`（backfill_builders 参数名 `arm` 保留——`job_runners.py:315` 与 `cli/backfill.py:347,597` 以关键字 `arm=` 传参，属 Lane C 域文件，避免跨 lane 强制联动）。

## 6. 覆盖率自证（grep pattern 集合）

在仓库根对 `src/`（+ `main.py`、`webhook-server/`、`tests/`）执行，各 pattern 命中已 100% 归入上述表格或登记：

```
\.arm\.                    # arm 面方法调用（36 命中，§1.1/§5.1）
\.radar\.                  # radar 面方法调用（12 命中，§1.2/§5.2）
arm=|arm =|radar=|radar =  # 装配点 / 直构点（§4/§5）
backend\.arm|backend\.radar # 属性消费点（§4）
watcher\.arm|watcher\.radar # service.py 装配（§4）
\.probe_readiness\(|\.health_status\(|\.detect_new_emails\(|\.fetch_email_by_id\(|\.fetch_recent\(|\.append_draft\(|\.send_email\(   # 旧 Protocol 9 方法调用方（§2）
\.extract_thread_id\(|\.get_all_valid_row_ids|\.db_path|get_stats  # 疑似兼容面逐一证伪（§1.3）
SyncHealthCheck\(|NewWatcher\(|EventHandlers\(|MailAppFanout\(|NotionToMailSync\(  # 构造点全集
```

路径覆盖：`src/mail/` `src/events/` `src/sync/` `src/services/` `src/cli/` `src/init/` `src/llm_agent/` `src/project_progress/` `src/calendar_notion/` `src/calendar_sync/` `webhook-server/`（零命中——独立实现不 import src/）、`main.py`（零 arm/radar 直用）。

## 7. 组 2 附带的结构决策（报告主会话确认）

1. **watcher legacy 分支**（`backend=None`，仅 `new_watcher.py` 自带 main() 手动入口使用——tests 全仓零 `NewWatcher(` 构造）：改为构造 `AppleScriptBackend(settings)` 作为 self.backend。行为等价论证：SQLiteRadar.__init__ 从不抛（db 缺失仅置 db_path=None → is_available False）；默认 mailboxes（"收件箱,发件箱"）与 cfg.sync_mailboxes 默认一致。
2. **handlers 双参数合并**：`EventHandlers(arm=..., backend=...)` 两参数实为同一对象（service.py:202,215 都从 backend 取）→ 合并为单 `backend` 必传参数（原 arm 也必传位置一，对等替换）。
3. **`imap_folder_reader.py:541` 调 `self.backend._build_reply_mime`**：davmail-only 组件对 DavMailBackend 私有方法的内部协作，不进 Protocol，不动。
