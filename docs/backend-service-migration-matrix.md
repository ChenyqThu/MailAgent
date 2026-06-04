# 后端服务化迁移 — 能力矩阵 & 验收看板

> 配套设计方案：`~/.claude/plans/cli-streamed-brook.md`（9 阶段序列）。
> 本文件是**活的执行/验收看板**，每阶段末更新。它把「覆盖完整性」变成可机械核对的表，
> 专治系统改造里「哪个接口漏改 / 漏对接」。分支：`feat/backend-service-layer`。

## 为什么需要这张表

这次改造的全部风险 = 「某个写操作只改了一半的传输/客户端」。靠人脑记必漏。
五招叠加防漏（详见方案 §防漏方法）：① 能力矩阵看板（本表）② 契约测试锚点
③ 删除驱动 + 编译器枚举调用点 ④ 穷举 caller + 残留检测 ⑤ 每阶段 green-gate + parity golden。

## 能力矩阵（写/计算操作 × 传输/客户端）

每个操作**所有列绿 = 该操作 done**。图例：✅ 完成 · �doing · ⬜ 待办 · ➖ 不适用 · 🍴 仍 fork CLI（迁移目标=消灭）

| 操作 | 领域 service<br>`src/services/` | CLI 适配器<br>（薄壳） | serve-api 端点<br>（in-process 非 fork） | Electron 客户端<br>（daemon HTTP） | schema 契约测试 | parity golden<br>（service==旧 CLI） |
|---|---|---|---|---|---|---|
| set_flags（flag/read/状态） | ✅ A2 | ✅ A2 | ✅ A2 | ✅ D1 | ✅ 已存在 | ✅ A2 |
| resync | ✅ A2 | ✅ A2 | ✅ A2 | ✅ D1 | ✅ 已存在 | ✅ A2 |
| archive | ✅ A3 | ✅ A3 | ✅ A3 | ✅ D1 | ✅ 已存在 | ✅ A3 |
| pin / unpin | ✅ A3 | ✅ A3 | ✅ A3 | ✅ D1 | ✅ 已存在 | ✅ A3 |
| llm_run | ✅ A3 | ✅ A3 | ✅ A3 | ✅ D1 | ✅ 已存在 | ✅ A3 |
| compose_draft | ✅ A4 | ✅ A4 | ✅ A4 | ✅ D1 | ➖<br>(无独立 schema) | ✅ A4 |
| send | ✅ A4 | ✅ A4 | ✅ A4 | ✅ D1 | ➖<br>(无独立 schema) | ✅ A4 |
| compose_plan（dry-run） | ✅ A4 | ✅ A4 | ✅ A4 | ✅ D1 | ➖<br>(无独立 schema) | ➖ |
| draft 创建（AppleScript） | ➖ host-local | ➖ | ⬜ D1 `POST /api/drafts` | shell fork 保留<br>（emergency 回切） | ➖ | ➖ |
| **长任务** batch_resync | ✅ C1 job | ✅ LongTaskContext | ✅ C1 `POST /api/jobs` | ✅ D2b<br>(batchResync+watchResyncJob) | ✅ 已存在 | ✅ C1 |
| **长任务** backfill_body/deriv/meta | ✅ C1 job | ✅ LongTaskContext | ✅ C1 `POST /api/jobs` | ➖ 运维 | ✅ 已存在 | ✅ C1 |

## 读路径（保留直读，仅追 wire-shape parity）

> 决策：本地 Electron 读保留直读 SQLite（read-replica 快路径，4ms），不收编进 daemon。
> 只需保证「TS 直读形状」「Python EmailRepository 形状」「serve-api 端点形状」三者一致。

| 读操作 | Electron 直读(TS) | EmailRepository(Py) | serve-api 端点 | wire-shape 去重 |
|---|---|---|---|---|
| list / list_enriched | ✅ | ✅ | ✅ | ✅ D2a `wire.meta_record_to_list_item` |
| get / body | ✅ | ✅ | ✅ | ✅ D2a `wire.meta_to_dict`(±`include_important`)/`body_summary`/`attachment_to_dict` |
| search(FTS5) | ✅ | ✅ | ✅ | ➖ 非 D2 范围(EmailSearchHit 投影各端未重叠) |
| mailboxes / thread / snippets / ai_fields | ✅ | ✅ | ✅ | ➖ 非 D2 范围 |
| attachment list / download | ✅ | ✅ | ✅ | ✅ D2a `wire.attachment_to_dict(include_internal_id)` |
| calendar / folder | ✅ | ✅ | 🟡 骨架 | ➖ folder `_attachment_to_dict` 接 dict 不并入(结构不同) |

## 横切基础设施

| 项 | 状态 | 阶段 |
|---|---|---|
| ServiceError 体系（transport-neutral）+ CODE_TO_EXIT | ✅ | A1 |
| guards：Actor + require_write_auth + check_pm2_conflict | ✅ | A1 |
| ServiceContext / ServiceDeps | ✅ | A1 |
| outbox merge 原子 SQL + JS/Py 契约测试 | ✅ | B1 |
| async_jobs 表 + JobWorker（挂 serve） | ✅ | C1 |
| 双层鉴权（本地 token + CF Access）+ SSE 9200 鉴权 | ✅ | C2 |
| serve-api 崩溃自拉起 + 断路器 | ✅ | C2 |
| 前端统一 http_client 写路径 | ✅ | D1 |
| backfill builder 下沉 engine 层（`sync/backfill_builders.py`，消除 sync→cli 反向 import） | ✅ | D2a |
| 读 wire-shape 投影单一真源（`services/wire.py`，email/attachment record→dict） | ✅ | D2a |
| 前端 batch_resync jobs 接线（`daemon_api`→`POST /api/jobs` + `GET` 轮询 + `job.*` SSE + `watchResyncJob` 进度 toast + BatchActionBar 按钮） | ✅ | D2b |

## 残留检测（每阶段末跑，应为「预期内」或空）

```bash
# A2-A4 推进中：serve-api router 里还在 fork CLI 的写端点（目标逐步归零）
grep -rn "run_cli(" src/api/routers/ | wc -l        # 基线 12 → A2 后 10 → A3 后 7 → A4 后 4（消 email
                                                    # draft/send/draft-plan 各 1）；余 4 = admin 2
                                                    # + email 1（legacy notion update-flag）+ llm 1
                                                    # （selftest 读命令，不烧 token）。A 系列 fork 已清零，
                                                    # 余 4 全是 D1/后续阶段目标（非 compose）
# C1: jobs router 全 in-process (run_cli 仍 4 — C1 新增端点不 fork); 分层不变式保持
grep -c "run_cli\|cli_runner" src/api/routers/jobs.py   # = 0 (in-process)
grep -rn "from src.cli\|import src.cli" src/services/    # 空 (src/services/ 零 cli import 不变式)
# C2: dual-auth + SSE 门接线 (header/env 名三处一致; 改鉴权 dependency 不碰端点 fork)
grep -rl "X-MailAgent-Local-Token" src/api/auth.py src/sse_server.py \
  frontend/src/electron/main/local_token.ts | wc -l     # = 3 (header 名三处一致)
grep -rn "run_cli(" src/api/routers/ | wc -l            # 仍 = 4 (C2 不动端点 fork)
grep -rln "maybeRestartAfterCrash" frontend/src/electron/main/backend_lifecycle.ts  # serve-api 崩溃自拉起就位
# D1 后：前端 TS 直写 outbox 应消失
grep -rn "writeFlagDirect" frontend/src/            # D1 后应为空
# D1 后：前端 fork CLI 写应消失（保留 draft.ts 的 AppleScript emergency fork）
grep -rn "callCli(" frontend/src/electron/main/handlers/write_ops.ts   # D1 后应为空
# D2a 后：backfill builder 下沉 engine 层 → job_runners 不再 sync→cli
grep -c "from src.cli.commands import backfill" src/sync/job_runners.py   # D2a 后 = 0
grep -rn "from src.cli\|import src.cli" src/services/wire.py src/sync/backfill_builders.py  # 空（两新模块零 cli import）
# D2a 后：读 wire 投影收编单一真源 → CLI + routers 不再各自 def helper
grep -rn "^def _meta_to_dict\|^def _meta_record_to_list_item\|^def _body_summary" \
  src/cli/commands/email.py src/api/routers/email.py src/cli/commands/attachment.py  # 空
# D2b 后：前端 batch_resync 接线就位（新增能力, 非消除）；后端零改动
grep -c "batchResync" frontend/src/shared/api/types.ts frontend/src/shared/api/ElectronApi.ts \
  frontend/src/shared/api/HttpApi.ts frontend/src/electron/main/handlers/write_ops.ts  # 各 ≥1
grep -rln "watchResyncJob" frontend/src/shared/state/resyncJob.ts \
  frontend/src/shared/components/email/BatchActionBar.tsx   # 2 文件（定义 + 调用）
grep -rn "run_cli(" src/api/routers/ | wc -l                # 仍 4（D2b 零后端改动）
# 全程：契约测试锚点必须全绿
pytest tests/cli/test_schema_contract.py -q
```

## 最终验收 gate（D2）

- [ ] 能力矩阵所有写操作 100% 绿（无 🍴 残留）
- [ ] `pytest tests/cli tests/api` + `cd frontend && pnpm test` 全绿
- [ ] `test_schema_contract` 全程全绿（data 形状零漂移）+ 每操作 parity golden 通过
- [ ] 残留检测：`run_cli` 仅剩 long-task 预期项、`writeFlagDirect`/`callCli` 写为空
- [ ] 性能基线前后对比：serve-api 写 ~500ms→几十 ms（数字化「感觉慢」）
- [ ] 端到端：每个写操作从 CLI / 本地 Electron / 远程 web 各实跑一遍
- [ ] 迁移监控：`email_outbox` dead_letter / gt_30m pending 无异常堆积
- [ ] 文档更新：CLAUDE.md 文档地图 + docs/claude/ 服务层架构文档 + 本看板归档

## 进度日志

- **A1（✅ 完成）** `feat/backend-service-layer`：新建 `src/services/{__init__,errors,guards,context}.py`；`cli/exceptions.py` 改 `CliError(ServiceError)` + `CODE_TO_EXIT`；`cli/pm2_check.py` 退化 shim；`cli/output.py::emit_cli_error` 加 exit_code 回填。CliContext **零改动**（保 `ctx._sync_store` 注入）。

- **A2（✅ 完成）** `feat/backend-service-layer`：set_flags + resync 下沉到 `src/services/mail_write.py::MailWriteService`（`plan_flags`/`set_flags`/`plan_resync`/`resync` + `FlagResult`/`ResyncResult` dataclass）。
  - **CLI 退化**：`email_flag` / `_resync_single` 调 service；`_resync_single` 加 `allow_concurrent` 参数 + 自做 `require_auth`（token，exit 4）；`email_resync` 父命令把 auth+pm2 从「single+batch 共用」改成「single 委托 service / batch 自留」（避免 single 路径 double pm2）。守卫分工：**token 校验留 CLI 侧（require_auth），actor 鉴权 + pm2 在 service**。
  - **serve-api in-process**：`resync_email` / `flag_email` / `flag_emails_batch` 从 `run_cli` fork 改 `await asyncio.to_thread(svc.method, ...)`；新增 `deps.get_service_ctx()`（**每请求新建**非单例 —— NotionClient httpx 连接池绑首个 loop，resync 走 asyncio.run 每次新 loop）；新增 `_raise_from_service_error` / `_extract_flag_mutation` / `_run_flag_service`，删 `_build_flag_mutation_args` / `_run_flag_cli`。「恒 allow_concurrent」决策上移到 HTTP 适配器。
  - **outbox source**：service 硬编码 `source='cli'`（维持 parity；旧 CLI 直写 + 旧 serve-api fork 都落 'cli'；echo prevention 只特判 notion_webhook）。
  - **dead path 清除**：email flag 不走 LongTaskContext → 无 partial_failure，serve-api flag 的 207 路径删除（连同 test_email_write_cli_args.py 的 flag argv 测试整段迁出）。
  - **验收**：`pytest tests/cli tests/api` = **648 passed, 1 failed**（唯一失败=预存 env-coupled `test_resolve_allowed_email`，与基线逐字一致）；新增 `tests/cli/test_service_parity.py`（12，golden 字面量 + CLI==service 逐字节）+ `tests/api/test_email_write_service.py`（22，in-process 参数透传/错误映射/dry-run 跳 auth/校验早于 service）；`test_schema_contract` 全绿。残留：`run_cli(` in routers 12→10。ruff 全绿。未碰前端。
  - **独立 review（code-reviewer subagent）**：**APPROVE / 可合并**，0 Critical / 0 High，7 维度全 PASS；实测 `data/sync_store.db` sha256 测试前后逐字节不变（无误写生产库）。2 Medium = 有意 parity 决策确认（207 dead-path 删除属 vestigial / path-id-vs-ids 沿用 TS 客户端），非缺陷。
  - **已知 gap（不阻塞 A2，归最终 E2E gate）**：serve-api flag/resync 的「HTTP→真实 ServiceContext→真 DB」E2E 未单测（API 单测按设计 patch MailWriteService spy；service 真实行为已由 `test_service_parity` 对真 ServiceContext+seeded_db 覆盖）。补在 D2 最终验收的「每写操作从 CLI/本地 Electron/远程 web 各实跑一遍」。
  - **next-phase handoff → B1 或 A3**：
    - **B1**（outbox merge 原子 SQL + JS/Py 契约测试）：是 D1（前端写收编）的**硬前置**，且独立于 A 系列。设计见 plan §B1：把 `OutboxRepository.enqueue` 的 read-modify-write merge 换成单条原子 `INSERT ... ON CONFLICT(internal_id,op_type,target) WHERE status='pending' DO UPDATE SET payload_json=json_patch(...)`（partial unique index + json1），消「TS write_ops.ts:319 与 Python outbox.py merge 两份手抄」+ read-modify-write 竞态。需走 `/db-migration` skill（bump DB_VERSION + idempotent migration + 同步前端 `EXPECTED_DB_VERSION`）。风险中。
    - **A3**（archive + pin + LlmService.run）：延续 A2 模式把 `email archive`（IMAP MOVE + Notion mirror，保「Notion 失败仅 warn」）/ `set_pin` / `llm run` 搬进 service，serve-api archive/pin/llm 端点改 in-process（再消 ~3 个 run_cli call-site）。风险中。
    - 顺序无硬约束（B1 只硬前置于 D1）；建议先 A3 把 A 系列连续做完（同一套 service+adapter 模式，惯性低），B1 留到 D1 前。**A2 的 source='cli' 硬编码 + get_service_ctx 每请求新建**两点 B1/C2 可复用/复审。

- **A3（✅ 完成）** `feat/backend-service-layer`：archive + pin/unpin + llm_run 下沉。
  - **service 层**：`MailWriteService` 加 `archive`/`plan_archive` + `set_pin`/`plan_pin`（+ `_folder_imap_reader`/`_update_notion_mailbox` 私有方法 + `ArchiveResult`/`PinResult` + `_ARCHIVE_MAILBOX` 常量）；新建 `src/services/llm_service.py::LlmService.run`（+ `LlmRunResult` + `_maybe_davmail_backend`）。archive 搬自 `email_archive` 1152-1196、pin 搬自 `email_pin`/`email_unpin`、llm 搬自 `llm_run` 87-142，逐字段对齐旧 emit data。
  - **config 访问**（A3 新地基）：`ServiceDeps` Protocol 加 `config` 契约 + `CliContext` 加 `config` property 别名（=cli_config，只读零风险，保 A1/A2「CliContext 零改动」精神）—— LlmService 经 `ctx.config` 拿 attachment_storage_dir/mailagent_backend/sync_store_db_path，尊重各传输持有的 cfg（**不读全局 src.config.config，否则 test_service_parity 注入的 cli-scoped cfg 失效**）。
  - **守卫分工**（关键决策）：① **archive/pin 不做 pm2 检测**（原 CLI 无 → service 方法不调 check_pm2_conflict、无 allow_concurrent 参数）。② **archive token-auth 上移**（原 CLI [already-archived → require_auth(token)]，退化后 CLI 适配器 token 校验早于 already-archived/meta；仅「无 token+已存档」双重错误时报哪个不同，现存测试全 _bypass_auth 不可见，与 A2 架构一致；service 内 require_write_auth 仍在 already-archived 之后）。③ **llm dry-run 真跑 LLM 不写 Notion → 跳过 write auth**（与 CLI `if not dry_run: require_auth` 一致）。token 校验留 CLI 侧，require_write_auth(actor) 在 service。
  - **llm backend**：service `_maybe_davmail_backend` 复刻 CLI `_maybe_create_davmail_backend`（davmail 才给 backend / 否则 None → LLMRunner lazy-init AppleScriptArm），但读 `ctx.config` 而非全局 cfg。CLI `_maybe_create_davmail_backend` **保留**（retry-failed 还用，不删）。
  - **serve-api in-process**：`archive_email`/`pin_email`（email router）+ `llm_run`（llm router）从 run_cli fork 改 `await asyncio.to_thread(svc.method)`；llm router 加 `_raise_from_service_error`（仿 email router）+ ServiceError/Actor/LlmService/get_service_ctx import；保留 run_cli（selftest 读命令仍 fork）。pin 端点保留 router 层 pinned bool 校验（早于 service 构造）。
  - **pin changed 统一**：`_pin_changed = (already != pinned)`，等价原 pin `not already` + unpin `was`。pin/unpin meta-None hint 统一带「Use email list」（原 unpin 无 hint，纯改进）。unpin race NotFound（原 unpin 不检 set_pin 返回 None，现统一检 → 更正确）。
  - **验收**：`pytest tests/cli tests/api` = **677 passed, 1 failed**（唯一=预存 env-coupled `test_resolve_allowed_email`，与 A2 逐字一致）；新增 `test_service_parity` archive/pin/llm golden + CLI==service（dry-run + **executed-path 逐字节相等**，补 review M1）；新增 `test_email_write_service` archive/pin/llm-run 端点 spy 测试；`test_email_archive` monkeypatch 路径随迁 service method；`test_email_write_cli_args` 删 3 个 archive argv 测试（迁 in-process）。`test_schema_contract` 全绿（llm-run dry-run schema 不漂移）。残留：`run_cli(` routers **10→7**。ruff 全绿。**未碰前端**。
  - **独立 review（code-reviewer subagent，opus）**：**APPROVE WITH NITS**，0 Critical / 0 High，6 个 parity 决策全部独立验证正确；实测 `data/sync_store.db` sha256 测试前后逐字节不变。2 Medium = M1 executed-path 相等测试（已补）+ M2 commit 卫生（只 stage A3 的 12+1 文件，不混 .claude/Trellis 工具改动）。
  - **next-phase handoff → A4 或 B1**：
    - **A4**（compose: draft / send / draft-plan）：A 系列最后一块，最重命令。`mail_write.py` 加 `compose_draft`/`send`/`compose_plan` + `ComposeRequest`（搬 `_prepare_draft` + `email_draft`/`email_send` 命令体，整段搬迁不重写）。**净简化**：serve-api 今天用临时文件 `--body-html-file` 传 bodyHtml（routers/email.py `_build_compose_args` + `_cleanup_tmp`），service 化后直接传字符串，临时文件那段整段删（连同 test_email_write_cli_args 的 draft/send/draft-plan argv 测试迁出）。风险中高（compose 逻辑最密；send 不可逆，parity 用 dry-run + mock backend）。消 email router run_cli 3 个（7→4）。
    - **B1**（outbox merge 原子 SQL + JS/Py 契约测试）：D1 硬前置，独立于 A 系列，留 D1 前做。走 `/db-migration`（bump DB_VERSION + 同步前端 EXPECTED_DB_VERSION）。
    - 建议先 A4 收尾 A 系列（同一套 service+adapter 模式，惯性最低）。**A3 的 ServiceDeps.config 别名 + LlmService `_maybe_davmail_backend` 复刻 + archive token-auth 上移决策** A4/后续可复用/复审。

- **A4（✅ 完成）** `feat/backend-service-layer`：compose draft / send / draft-plan 下沉，**A 系列收官**（写操作 fork CLI 清零）。
  - **service 层**：`MailWriteService` 加 `compose_plan`/`compose_draft`/`send` + `ComposeRequest`/`ComposeDraftResult`/`ComposeSendResult`；从 CLI **整段搬迁不重写** 5 个 module helper（`_split_addrs`/`_reply_md_to_html`/`_compose_reply_draft`/`_build_forward_intro`/`_build_reply_quote`）+ 3 个 service method（`_fetch_reply_suggestion_md`/`_collect_forward_attachments`/`_prepare_draft`）。reviewer AST 验证：forward_intro/reply_quote 逐字节相同、`_compose_reply_draft` 仅多 `self_email` 参数、其余仅 `cli.*`→`self._ctx.*`。
  - **净简化（字符串 body）**：service `_prepare_draft` 接**字符串** body_html/body_text（非文件路径）；CLI 适配器新增 `_build_compose_request` 读 `--body-file`/`--body-html-file` 成字符串；serve-api 直接传 TipTap HTML 字符串 —— 旧 fork 路径的 `--body-html-file` 临时文件那套（`_build_compose_args`+`_cleanup_tmp`+`tempfile`/`os` import）整段删。body 优先级 body_html>body_text>SQLite 对齐旧 body_html_file>body_file>reply_md。
  - **守卫分工（关键决策，与 A3「token 上移」分歧）**：compose 有**非 _bypass_auth 测试**（`test_draft_forward_requires_extra_to`→E_INVALID_ARG / `test_draft_real_no_reply_suggestion_errors`→E_NOT_FOUND）要求**业务校验先于 auth**（旧 email_draft 顺序：_prepare_draft NotFound→forward 校验→require_auth）。故 CLI 适配器把 `cli.require_auth()` 的 raise **转成 `authed` bool**（不提前 raise），构造 `Actor(authenticated=authed)` 传 service；service 在业务校验**之后**才 `require_write_auth(actor)`。三重保证：① 保持业务先于 auth 原顺序；② `_bypass_auth`（patch require_auth no-op）→authed=True 仍生效；③ ServiceAuthError==CliAuthError==E_AUTH_FAILED→exit 4 / HTTP 403 不变。compose **不做** pm2 检测（原 CLI 无 → 无 allow_concurrent）。
  - **send 二次确认**：`send(confirmed)` —— confirmed=False（json 无 --yes）→ ServiceInvalidArgError「发送需二次确认」（对齐旧）；HTTP /send 端点恒 confirmed=True（前端已弹 SendConfirmDialog）；CLI text 交互 confirm 留适配器（compose_plan 预览 to/cc/subject + typer.confirm）。不可逆路径安全闸完整（auth→确认→send_email，send_email 严格最后）。**已知 LOW 边缘**（reviewer 确认 Acceptable）：text 交互+无 reply_suggestion 时确认后才报 NotFound（compose_plan allow_missing 预览，非 send_email），前端 json 路径不受影响，已加注释。
  - **_compose_reply_draft self_email**：参数默认 None→读全局 config（纯函数测试便利保留），service 显式传 `self._ctx.config.user_email`（A3「不读全局」原则）。reviewer 验证 CliContext.config=cli_config 别名 + `_sync_global_cfg_from_cli` 推全局 → 运行时两路同值，reply-all 自我排除零漂移。
  - **serve-api in-process**：compose_draft/compose_send/draft_plan 从 run_cli fork（+临时文件）改 `await asyncio.to_thread(svc.method)`；新增 `_compose_request_from_body`（camelCase body + list 收件人→ComposeRequest，to/cc/bcc join 逗号串、bodyHtml 直传字符串）+ `_require_compose_internal_id`；保留 `_validate_compose_mode`（mode 校验早于 service）。
  - **验收**：`pytest tests/cli tests/api` = **694 passed, 1 failed**（唯一=预存 env-coupled `test_resolve_allowed_email`，与 A2/A3 逐字一致）；`test_service_parity` 新增 14 compose（golden + CLI==service draft/send 逐字节）；`test_email_write_service` 新增 11 compose 端点 spy；`test_email_draft` import 改指向 service（纯函数测试随迁）；**删** `test_email_write_cli_args.py`（整文件是 compose fork argv，1:1 迁入 service 端点测试）。`run_cli(` routers **7→4**（A 系列 fork 清零；余 4=admin 2+email 1 legacy update-flag+llm 1 selftest）。ruff 全绿。**未碰前端**。
  - **独立 review（code-reviewer subagent，opus）**：**APPROVE**，0 Critical/0 High/0 Medium，7 个 parity 决策全部独立验证（含 AST 逐字节对比）；实测 `data/sync_store.db` sha256 测试前后不变（`1c1872bb…73dd494`）；service 无 `src.cli` import（分层干净）。1 LOW（text 交互 send 边缘，已加注释）+ 2 NIT（_split_addrs ruff 空行无影响 / `.claude/settings.json` 工具改动不进 A4 commit —— commit 已只 stage 6 src+tests）。
  - **next-phase handoff → B1 或 C1**（A 系列收官，剩横切基础设施 + 前端收编）：
    - **B1**（outbox merge 原子 SQL + JS/Py 契约测试）：**D1 前端写收编硬前置**。把 `OutboxRepository.enqueue` 的 read-modify-write merge 换成单条原子 `INSERT...ON CONFLICT(internal_id,op_type,target) WHERE status='pending' DO UPDATE SET payload_json=json_patch(...)`（partial unique index + json1），消「TS write_ops.ts:319 与 Python outbox.py 两份手抄 merge」+ read-modify-write 竞态。走 `/db-migration`（bump DB_VERSION + 同步前端 `EXPECTED_DB_VERSION`）。风险中。
    - **C1**（async_jobs 子系统）：长任务（batch_resync/backfill）走统一 API 的前置，新建 async_jobs 表 + serve 进程 JobWorker（复用 `cli/long_task.py::LongTaskContext` + SSE 9200）。风险中高（新子系统）。
    - 建议先 **B1**（D1 硬前置、独立小改动）再 C1。**A4 的 authed-bool token 处理 + ComposeRequest 字符串 body + compose_plan 预览复用** 可供 D1 前端写收编复审。

- **B1（✅ 完成）** `feat/backend-service-layer`：outbox merge read-modify-write → **单条原子 UPSERT**（partial unique index + `json_patch`），消「TS write_ops.ts 与 Python outbox.py 两份手抄 merge」+ read-modify-write 竞态。**D1 前端写收编硬前置就位**。
  - **DB migration（v19→v20）**：`sync_store.py` 加 v20 block —— **先 dedup** 历史竞态重复 pending 行（同 (internal_id,op_type,target) 多 pending → 按 outbox_id 升序合并 payload 保留 max 行、删其余），**再建** partial unique index `ux_outbox_pending_intent ON email_outbox(internal_id,op_type,target) WHERE status='pending'`（dedup-before-index 顺序硬约束，否则建索引违反唯一性）。idempotent（重跑无重复→no-op；index `IF NOT EXISTS`）。bump `DB_VERSION` 19→20 + 同步前端 `EXPECTED_DB_VERSION`（`admin.py` 两处 `=_SyncStore.DB_VERSION` 动态派生不用改；`db_version_consistency.test.ts` 自动校验）。
  - **原子 UPSERT（语义真源 = SQLite 引擎）**：`OutboxRepository.enqueue` + `writeFlagDirect` 的 enqueueOne 换**同一条** SQL：`INSERT ... ON CONFLICT(internal_id,op_type,target) WHERE status='pending' DO UPDATE SET payload_json=json_patch(payload_json,excluded.payload_json), source=COALESCE(excluded.source,source), updated_at=excluded.updated_at RETURNING outbox_id, (created_at=updated_at) AS was_inserted`。两份手抄 read-modify-write merge 删除（残留检测见上）。
  - **payload_json 字节统一**：INSERT=紧凑 sorted（Python `json.dumps(separators=(",",":"))` / TS `JSON.stringify(payload, keys.sort())`，修「Python 旧带空格 vs TS 紧凑」漂移）；merge=json_patch（紧凑、保留 base key 顺序、新 key 追加于尾、后写覆盖同 key RFC7396）。中文不转义（实测）。RFC7396 null-delete 不可达（所有 caller op_type=`flag_sync`、经 `_flag_payloads` 只放非 None；已加注释强化不变式）。
  - **行为保持 parity**：`was_inserted`（created_at==updated_at）区分 INSERT/merge → SSE `outbox.enqueued` 仍**仅 INSERT 发**（merge 不发）+ SSE 移出 DB 事务；echo prevention（source='notion_webhook'+target='notion'→-1）保留；enqueue 返回 INSERT 新 id / merge existing id。**已知 LOW**（reviewer Acceptable）：亚毫秒同 key 连写时 was_inserted 误判 → 仅影响 outboxIds/mergedIds 分类 + 一次多余 SSE，payload_json 字节不受影响。**TS 直写 SSE 漏发仍 deferred 给 D1**（B1 范围 = payload 字节 parity，非 SSE parity）。
  - **测试**：新增 `tests/sync/test_outbox_parity.py`（3，Python payload_json 字节 golden）+ `frontend/tests/main/write_ops_outbox_parity.test.ts`（4，TS 侧**同一 golden** `GOLDEN_NOTION`，in-memory better-sqlite3 + mock getWriteDb）→ **JS/Py 逐字节契约**；`tests/mail/test_sync_store_v20_migration.py`（5，partial index 防重 / partial 只约束 pending / v19→v20 dedup+payload 合并 / idempotent）。现有 `tests/sync/test_outbox.py`（40）全绿（紧凑 sorted INSERT 仍 `startswith('{"is_flagged"')`、merge 用 dict 比较不依赖字节）。
  - **验收**：`pytest tests/cli tests/api` = **694 passed, 1 failed**（唯一=预存 env-coupled `test_resolve_allowed_email`；test_schema_contract + test_service_parity 全绿）；`tests/sync+mail+events` 除 **8 个预存失败**（stash 确认：2 个 outbox `update_local_flags` mock 过时 + 6 个 expansion_loop）外全绿；前端 `pnpm test` 除 **9 个预存 EmailRow i18n 失败**外全绿（含 4 契约 + 27 write_ops 回归）。副本 migration 真实生产库（1074 outbox 行）19→20 成功 + 幂等 + 无重复 pending。better-sqlite3 测后 `rebuild:electron` 还原 ABI。
  - **独立 review（code-reviewer subagent，opus）**：**APPROVE**，0 Critical/0 High；在 Python + Electron **两 runtime 实跑 golden 确认逐字节一致**（json_patch 在 bundled Electron SQLite 可用）。3 LOW（was_inserted 亚毫秒边缘 Acceptable / RFC7396 null-delete latent 已加注释 / commit scope hygiene 只 stage 7 文件）+ 2 NIT（TS SSE→D1 deferred / merge 非全 sorted by design）。
  - **⚠️ 事故记录**：review subagent 在**共享工作区**跑 `git checkout main` 验证基线后**未切回** + 移除 tracked 看板文件（main 无此文件）→ 已 `git checkout feat/backend-service-layer` 恢复 A 系列 tracked 文件 + 看板。**教训**：派会跑 `git checkout/reset/clean` 的 subagent 到共享 worktree 有风险（即便禁 Write/Edit，Bash 仍能改 git 状态/HEAD），应限定其只读 git，或用 `isolation:worktree`。
  - **next-phase handoff → C1**（B1 收官；A+B 阶段全完成，剩 C1/C2/D1/D2 横切基础设施 + 前端收编）：
    - **C1**（async_jobs 子系统）：长任务（batch_resync/backfill）走统一 API 前置。新建 async_jobs 表（DB migration，**B1 已把 DB_VERSION 推到 20 → C1 用 21**）+ serve 进程 JobWorker（复用 `cli/long_task.py::LongTaskContext` 的 checkpoint/熔断/SIGINT + SSE 9200 进度推送；执行进程=**serve** 非 serve-api）。HTTP `POST /api/jobs` 只 enqueue + `idempotency_key` 防弱网重发 + claim 用条件 UPDATE（仿 `fanout.py:116`）。风险中高（新子系统）。
    - **C2**（双层鉴权本地 token + CF Access + SSE 9200 鉴权 + serve-api 崩溃自拉起）、**D1**（前端写收编 daemon + 删 `writeFlagDirect`，**B1 的原子 UPSERT + 契约 golden 即其安全网**）、**D2**（读 wire 去重 + 最终验收 + 文档）。
    - **B1 复用点**：`ux_outbox_pending_intent` 的 UPSERT 范式（C1 job claim 条件 UPDATE 可仿）；JS/Py 契约 golden 模式（D1 收编后回归保护）；`was_inserted` 判别（C1 如需区分 insert/update 可复用，注意亚毫秒边缘）。

- **C1（✅ 完成）** `feat/backend-service-layer`：async_jobs 长任务子系统（batch resync + backfill body/derivatives/metadata 走统一 daemon API）。**横切基础设施就位**（A+B+C1 全完成）。
  - **DB v20→v21（纯加表）**：`sync_store.py` `_init_database` 加 `async_jobs` 表（job_id PK / job_type / target_kind|key / params_json / status(queued→running→succeeded|partial_failure|failed|aborted) / idempotency_key / progress_done|total / checkpoint_internal_id / result_json / 时间戳）+ `ux_async_jobs_idempotency` partial unique（WHERE idempotency_key IS NOT NULL）+ `ix_async_jobs_status`。`CREATE TABLE IF NOT EXISTS` 无条件跑 → 新/老库都建，**无 data migration**。bump `DB_VERSION` 21 + 前端 `EXPECTED_DB_VERSION` 21（`db_version_consistency.test.ts` 自动校验通过）。**不复用 email_outbox**（outbox=字段级 merge 幂等 intent；job=带 checkpoint/熔断/进度的过程，语义不同，强塞破坏 merge 不变式）。
  - **`AsyncJobRepository`（`src/sync/async_jobs.py`，仿 OutboxRepository）**：`enqueue`（**幂等**：`INSERT ... ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING` → 命中既有 key 回查既有 job_id + was_created=False，弱网重发不重复起；NULL key 恒 INSERT。比 B1 的 `created_at==updated_at` 探针更稳，**不依赖时钟分辨率**——reviewer L1 建议已落地）/ `claim_next`（SELECT 最老 queued + 条件 UPDATE queued→running 原子 claim，仿 `fanout.py:116`）/ `update_progress`（COALESCE 保留未传字段）/ `mark_terminal` / `recover_orphaned`（启动时 running→queued，crash resume 前置）/ `get`。
  - **job 执行器（`src/sync/job_runners.py`，engine 层）**：`run_resync_job` 复用领域类 `NotionSync.create_email_page_from_sqlite`（src/notion，**逐字段对齐 CLI `_resync_batch._make_unit`**，仅 `CliNotFoundError`→`ServiceNotFoundError`，二者 code 同为 `E_NOT_FOUND`）；`run_backfill_job` **lazy 复用** `cli/commands/backfill` 现成模块级 builder（`_pick_candidates`/`_make_body_units`/`_find_candidates`/`_make_derivative_units`/`_make_metadata_units`，**backfill.py 零改动**，完整下沉留 D2 wire 去重）；`drive_units` 共享 LongTaskContext driver（`install_signal_handler=False` + `checkpoint_every=0`，async_jobs 是 checkpoint 真源）；`summary_to_status` 映射终态。**关键决策**：job 执行器在 `src/sync/`（engine 层）而非 `src/services/` —— 因要复用 `cli/long_task`（plan §C1 钦定）+ backfill builder；这样 **`src/services/` 的「零 cli import」审计不变式保持干净**（grep 验证）。
  - **`LongTaskContext` 加 opt-in `on_unit_done` hook**（`run()` 新增可选回调，返 False → 协作式停止；CLI 不传 → **零行为变更**）+ `except CliError` 泛化为 `except ServiceError`（CliError 是 ServiceError 子类 → CLI 行为不变，但 job unit 抛的 ServiceNotFoundError 也拿到正确 `.code` 而非 E_INTERNAL）。
  - **`JobWorker`（`src/sync/job_worker.py`，挂 serve 进程，仿 FanoutWorker）**：asyncio loop 串行 claim + `asyncio.to_thread(run_job)` + 写终态 + SSE（`job.running`/`job.progress` 每 10 unit/`job.done`/`job.failed`）。启动 `recover_orphaned()` crash-resume，resume_from=checkpoint_internal_id+1。每 job 新建 ServiceContext（fresh NotionSync client，与 serve-api per-request 同语义——asyncio.run 每次新 loop 复用 client 会撞）。`stop()` 经 on_unit_done 返 False 协作式停。`service.py` start() 按 `MAILAGENT_ASYNC_JOBS_ENABLED`（默认关灰度）gate + create_task + shutdown stop；`self.job_worker=None` 在 `__init__`（reviewer L2 已落地）。
  - **serve-api 端点（in-process 无 fork）**：`src/api/routers/jobs.py` `POST /api/jobs`（enqueue，job_type 校验 + idempotencyKey 透传 + 仅新建发 `job.enqueued` SSE，**不做 pm2 检测**——job 在 serve=mail-sync 进程内跑不与自己冲突）+ `GET /api/jobs/{job_id}`（状态/进度/终态查询，404）；`deps.get_job_repo()` lazy 单例；`app.py` 注册。
  - **验收**：`pytest tests/cli tests/api` = **700 passed, 1 failed**（唯一=预存 env-coupled `test_resolve_allowed_email`；test_schema_contract + test_service_parity 全绿；C1 给 tests/api +6）。新增测试 **38 个全绿**：`tests/mail/test_sync_store_v21_migration.py`(6) + `tests/sync/test_async_jobs.py`(18, repo 全语义 + JOB_TYPES==VALID_JOB_TYPES + summary_to_status) + `tests/sync/test_job_parity.py`(4, **resync job 输出==CLI golden + E_NOT_FOUND parity**) + `tests/sync/test_job_worker.py`(4, e2e claim→执行→终态 + 协作式停 + checkpoint 续跑 + runner 失败) + `tests/api/test_jobs_api.py`(6, 端点 enqueue/get/校验/幂等 SSE)。前端 `pnpm test` 除 **9 个预存 EmailRow i18n** 外全绿（1271 passed，含 db_version 一致性）；测后 `rebuild:electron` 还原 ABI。残留：`run_cli(` routers 仍 **4**（C1 端点 in-process 不 fork）；`src/services/` 零 cli import（不变式保持）；ruff 新文件全绿。
  - **独立 review（code-reviewer subagent，opus）**：**APPROVE**，0 Critical/0 High/0 Medium，8 个核查项全 PASS（parity 逐字段对齐有 golden 锁死 / except 泛化经类层级证明 CLI 零变更 / 分层不变式 grep 确认 / claim 原子 + 幂等 / crash-resume 闭环 / migration 标准 / backfill 签名齐 / SQL 全参数化无泄漏）。确认只读 git + 未碰生产库。3 LOW（was_created 时钟边角→**已改 DO NOTHING 消除** / self.job_worker 初始化→**已移 __init__** / update_progress|mark_terminal 无 status 守卫=单 worker 不变式，已文档化）+ 2 NIT（陈旧 doc 引用→**已修** / aborted/partial 都发 job.done=data.status 可区分，留 D1）。
  - **next-phase handoff → C2**（C1 收官；剩 C2/D1/D2 横切基础设施 + 前端收编）：
    - **C2**（双层鉴权 + serve-api 崩溃自拉起）：远程 `verify_cf_access` 不动 + 本地 per-session ephemeral token（Electron `crypto.randomBytes` → env 注入 serve-api + IPC 给 renderer）；**SSE 9200 补鉴权**（C1 的 `job.progress` 经它推，远程 cloudflared 暴露时 CF Access 必须覆盖 9200，否则泄漏 internal_id + 操作时序）；`backend_lifecycle.ts::spawnService` 加指数退避 re-spawn + crash-loop 断路器。风险中。
    - **D1**（前端写收编 daemon + 删 writeFlagDirect）：依赖 B1+C1+C2。前端可经 `POST /api/jobs` 起长任务 + `GET /api/jobs/{id}` 轮询进度 + 消费 `job.*` SSE（events_bridge 接线）。**C1 复用点**：`AsyncJobRepository` 的 DO-NOTHING 幂等 enqueue 范式；JobWorker 的 on_unit_done 进度 hook；job 执行器在 sync 层复用 cli/long_task 的分层处理。
    - **D2**（读 wire 去重 + 最终验收 + 文档）：**把 backfill 的 `_pick_candidates`/`_make_*_units` 等 transport-neutral builder 从 `cli/commands/backfill.py` 正式下沉**（C1 lazy 复用是务实临时态，D2 wire 去重一并做，届时 `job_runners.run_backfill_job` 改 import 下沉后的模块）。

- **C2（✅ 完成）** `feat/backend-service-layer`：双层鉴权（本地 token + CF Access）+ SSE 9200 补鉴权 + serve-api 崩溃自拉起。**横切基础设施收官（A+B+C 全完成），D1 前端写收编前置就位**。
  - **8200 dual-auth（`src/api/auth.py`）**：`verify_cf_access` 前置一条**本地 token 腿**（CF JWT decode/allowlist 逻辑**一字不改**，纯前插）—— 配了 `_LOCAL_API_TOKEN`（env `MAILAGENT_LOCAL_API_TOKEN`）且 `X-MailAgent-Local-Token` header 经 `hmac.compare_digest` 匹配 → 放行本地身份（=allowed email，解析不出回落 `local@127.0.0.1` sentinel）；未配（`_LOCAL_API_TOKEN and ...` 短路停用，空 header 不可绕过）/ 不匹配 → 回落 CF JWT；都没有 → 401 fail-closed。47 个 router 的 `Depends(verify_cf_access)` **零改动**（仅扩 dependency 体）。**import 守卫放宽**：`if not AUTH_DISABLED and not CF_AUDIENCE` → 加 `and not _LOCAL_API_TOKEN`（判据「必须 CF_AUDIENCE」→「≥1 鉴权方式」；三种全无仍 RuntimeError 拒启 = fail-closed；AUTH_DISABLED-without-dev 守卫不动）。
  - **9200 SSE 门（`src/sse_server.py`）**：抽纯函数 `_local_token_ok(request)` —— 未配 token 放行（dev/pm2 serve 无注入 → 向后兼容）；配了则 header 必须 compare_digest 匹配。`_stream_events` **首行**早返回 401（在 `_get_redis_url()` / `prepare` 之前，不触 streaming、不泄漏、不 hang）；`_health` 仍无鉴权（liveness，仅暴露 coarse 计数无 internal_id/payload）。**关键决策**：9200 当前**未经 cloudflared 暴露**（只本地 Electron main 用 node fetch 连，远程 SSE 走 webhook-server 8100 独立端点），故只做**本地 token 校验**，不在 aiohttp 重做 CF JWT（若将来 tunnel 暴露由 CF Access 隧道层覆盖；已注释）。附带：预存未用 `import json`（F401，HEAD 即死）被仓库 ruff hook 顺手清掉（非 C2 逻辑 orphan，1 行透明标注）。
  - **token 生成/注入（前端 `local_token.ts` 新 + `backend_lifecycle.ts`）**：`getLocalApiToken()` 进程内单例（首用 `randomBytes(32).toString('hex')` = 256-bit hex）；`buildBaseEnv` 注入 `MAILAGENT_LOCAL_API_TOKEN` 给 **serve + serve-api 两进程**（9200 门 + 8200 dual-auth 都靠它；`serveApiEnv` 经 `{...baseEnv}` 继承同值不重生）；同一单例供 `events_bridge.ts` SSE fetch 带 `X-MailAgent-Local-Token` header → **两端天然同值**（消「两端 drift」一类 bug）。header/env 名三处手抄（auth.py/sse_server.py/local_token.ts），契约测试 + 🔴 注释钉死。
  - **serve-api 崩溃自拉起（`backend_lifecycle.ts`）**：`spawnService` exit handler 非主动 stop 退出（先 `child=null` 再调）→ `maybeRestartAfterCrash(svc)`（仅 serve-api；serve 崩由 waitReady 门控兜底降级）。指数退避 re-spawn（仿 events_bridge `BACKOFF_MS` 1s→2s→5s→10s→30s）+ crash-loop 断路器（连续崩溃达 `MAX_CRASH_RESTARTS=5`、中间无一次 ready → 放弃停 failed，防必崩配置烧 CPU）；`waitApiReady` 标 ready 时 `restartAttempts=0` 复位（`state==='starting'` 守卫下 clobber-safe）；`stopService` 清 `restartTimer` + timer 回调守卫 `state==='stopped'`/`child` 防停后复活；`restartService` 手动重启复位计数。退避梯度 + 上限经 `LifecycleOptions.crashBackoffMs/maxCrashRestarts` 可注入（仿 `apiProbe` 单测注入范式）。
  - **范围裁定（不属 C2，归 D1）**：renderer IPC token + http_client 带 header + flip `serveApiEnabled` 为常驻 —— 矩阵把「前端统一 http_client 写路径」划归 D1；`http_client.ts` 只被远程 web SPA 的 `HttpApi.ts` 用（Electron renderer 走 IPC 不用它，远程用 CF JWT 不带本地 token），8200 本地 token 消费者要到 D1 renderer 写收编才出现。**⚠️ 前瞻注记（reviewer LOW）**：8200 dual-auth 本地腿现已接好但**纯本地装机（无 CF_AUDIENCE）下 serve-api 不 spawn → 该腿暂不活跃**（仅单测覆盖能力）；唯一现存活跃本地消费者 = events_bridge→9200 SSE 端到端打通。D1 flip gate 后 8200 本地腿才上线。
  - **验收**：`pytest tests/cli tests/api` = **708 passed, 1 failed**（唯一=预存 env-coupled `test_resolve_allowed_email`；test_schema_contract + test_service_parity 全绿；C2 给 tests/api +8）。新增测试：`tests/api/test_auth_and_bind.py` +8（dual-auth 放行/sentinel 回落/mismatch-401/unconfigured-401/TestClient 端到端 ×2 + 放宽守卫 local-only 不崩/全空 raise）；`tests/events/test_sse_auth.py` 新 +6（`_local_token_ok` 全分支 + `_stream_events` 401 + header/env 名跨模块契约）；前端 `backend_lifecycle.test.ts` +6（token 注入两进程同值 + 崩溃自拉起 5: re-spawn/serve 不自拉/断路器/ready 清零[`maxCrashRestarts:1` 证复位 load-bearing]/stop 取消 pending）；`local_token.test.ts` 新 +4（单例/hex/reset/常量名）。前端 `pnpm test` = **1281 passed**，9 failed 全是预存 EmailRow i18n（C2 文件零失败）；测后 `rebuild:electron` 还原 ABI。残留：`run_cli(` routers 仍 **4**（C2 改鉴权 dependency 不碰端点 fork）；`src/services/` 零 cli import；header 名三处一致。ruff 全绿；tsc 0 error。
  - **独立 review（code-reviewer subagent，opus）**：**APPROVE**，0 Critical/0 High/0 Medium，7 个核查项全 PASS（CF JWT 逐字未改 diff 可证 / compare_digest 两腿都用 / 三种凭证缺失全 fail-closed / SSE 401 早于 redis / 两进程同 token 单源 / 断路器 reset-on-ready 经 `maxCrashRestarts:1` 测证 load-bearing / 无 D1 越界 grep 确认）。1 LOW = 上述 8200 腿前瞻注记（已纳入 handoff，非缺陷）+ 3 NIT（stale waitApiReady 协程并发但 `starting`-only 守卫中和无害 / `_health` 无鉴权计数可接受 / auth↔sse header 读法风格微异，均 reviewer 明示 not required）。确认全程只读、未碰 git 状态/工作树。
  - **next-phase handoff → D1**（C2 收官；剩 D1/D2）：
    - **D1**（前端写收编 daemon + 删 writeFlagDirect）：依赖 B1+C1+C2 全就位。`write_ops.ts` 删 `writeFlagDirect`、`email:flag`/复杂写（resync/pin/archive/llm/folder/draft/send）改调本机 daemon（复用 `http_client.ts`）。**C2 复用点**：① `getLocalApiToken()` 经 **IPC/preload** 暴露给 renderer → http_client 在 Electron 上下文带 `X-MailAgent-Local-Token` header（远程 web 仍走 CF JWT，不带本地 token）；② **flip `serveApiEnabled`**（`backend_lifecycle.ts:270`）为「本地 token 已生成即可起」（让没配 CF 的本地用户也起 serve-api 作写面）—— C2 放宽的 import 守卫 + 崩溃自拉起即其安全网；③ B1 的原子 UPSERT + JS/Py 契约 golden 是写收编回归网；④ events_bridge 接 `job.*` SSE（C1）。
    - **D2**（读 wire 去重 + 最终验收 + 文档）：backfill builder 下沉 + 能力矩阵 100% 绿验收 + CLAUDE.md 文档地图 + `docs/claude/` 服务层架构文档 + 本看板归档。

- **D1（✅ 完成）** `feat/backend-service-layer`：前端写操作收编到本机 daemon（main 进程转发 serve-api），删 `writeFlagDirect` + 前端写 fork CLI 清零。**写源从 4 收敛到 1（daemon service），剩 D2 最终验收**。
  - **架构方向（用户拍板）= Main 进程转发**（plan §D1 钦定，**否决** C2 handoff 设想的 renderer 直连）：renderer/ElectronApi **零改动**（仍走 IPC channel），main 侧 handler 内部 `callCli`/`writeFlagDirect` → `daemonRequest`。理由：renderer 零改动 / token 不进 renderer（renderer 是不可信邮件 HTML 宿主，攻击面最小）/ 读写分离干净（读仍 IPC 直读 SQLite 快路径）/ 符合 plan §D1 字面。renderer 直连被否（改动大 + token 进 renderer + 需调 CSP + 读 IPC 写 HTTP 混合不干净）。
  - **新增 `daemon_api.ts`**：`daemonRequest(method,path,opts)` = `http_client.request('http://127.0.0.1:<port>/api', …, {headers:{'X-MailAgent-Local-Token': getLocalApiToken()}})`，port 读 `MAILAGENT_API_PORT` 默认 8200（独立读 env 不 import backend_lifecycle，避免拉 electron app 进单测）。**复用 web SPA 同款 `http_client.request`**（plan 钦定「统一客户端」），注入 C2 本地 token → serve-api auth.py 本地腿放行；request 返回 envelope.data **原样**（不 renderer-unwrap）。`http_client.ts` 加 `RequestOptions.headers` 注入点（Accept 后 spread、Content-Type 最后设防覆盖；web 默认无 headers 行为零变化）。
  - **write_ops.ts（6 写收编）**：删 `writeFlagDirect` + 全部 CLI args builders；6 forwarder（runResync/runPin/runArchive/runLlmRun/runEmailFlag + `flagBody`）调 daemonRequest，**path/body/query 严格 mirror HttpApi**（llm 用 query 非 body / flag batch `/email/0/flag`+body.ids / flag body 只非 undefined + 不发 allowConcurrent）。handler guard 全保留。**notion:updateFlag**（legacy，renderer 无调用点）映射 daemon flag + dryRun guard（防静默真写）。
  - **draft.ts（compose 收编 + 净简化）**：删 composeArgs/runCompose 的**临时文件**（mkdtemp/writeFile→`--body-html-file`）整段 —— A4 已让 serve-api 直收 bodyHtml 字符串；3 forwarder（runComposeDraft/Send/DraftPlan）body 直传 ComposeDraftOpts。send 不带 --yes（serve-api 恒 confirmed=True）。**保留** createDraft（AppleScript host-local emergency 直 fork）+ validateComposeOpts。
  - **chat 写工具收编**：`chat/tools/builtin/write.ts` emailFlag/emailArchive 从 writeFlagDirect(同步) 改调 `runEmailFlag`(async+try/catch)，output `outbox_ids/merged_ids` → `updated_ids/outbox_entries`（**flag 单行是唯一 parity 形状断点**：原 writeFlagDirect `{outbox_ids,merged_ids}` vs daemon FlagResult；唯一读字段消费点=chat 工具，renderer 其它 flag 消费者 EmailRow/useInboxActionShortcuts/CommandPalette 只 await 不读 data）。emailDraftReply 保留 ipcCreateDraft。
  - **envelope.ts**：`envelopeFromCli` 加 ApiError 分支（带 string `code` 的 Error → {ok:false,code,hint}）—— daemon 抛 ApiError 非 CliError；CliError(errorCode)/ApiError(code)/普通 Error(E_DISPATCH) 三分支，admin/calendar 仍走 CliError 不受影响。
  - **backend_lifecycle.ts（serveApiEnabled flip，D1 硬前置）**：`CF_AUDIENCE 非空` → `REMOTE_ACCESS_ENABLED !== 'false'`。serve-api 成 **Electron 本地写面**（main 转发的前提），纯本地无 CF 也起；本地 token 恒由 buildBaseEnv 注入，C2 已放宽 auth.py import 守卫（≥1 鉴权方式）+ 崩溃自拉起作安全网。CF_AUDIENCE 仅决定「远程是否可达」。
  - **pin parity 关键决策**：runPin 返回**完整** `{internal_id,is_pinned,changed,dry_run}` data 块（request 返 env.data 原样，**不**像 HttpApi.pin unwrap 成 bool）→ ElectronApi.pin 的 `data?.is_pinned` 二次取字段继续工作，零改动。其余写 ElectronApi 纯 unwrap，daemon data==CLI data（A2-A4 service==CLI golden）天然 parity。
  - **验收**：`pytest tests/cli tests/api` = **708 passed, 1 failed**（唯一=预存 env-coupled test_resolve_allowed_email，与 C2 逐字一致，**Python 零回归** —— D1 不动 Python）。前端 D1 相关 **125 测试全绿**（write_ops/compose_draft/daemon_api/http_client/envelope/backend_lifecycle/chat builtin/dispatch 8 文件）；全量 pnpm test 除**预存 9 个 `EmailRow.test.tsx`**（stash baseline 验证：C2 基线 = 9 failed/1281 passed 全 EmailRow combo snapshot + isNew semantic，与 D1 无关）+ **flaky useEmailChat**（forks 并发 artifact，单独跑 36 绿）外全绿。typecheck exit 0；测后 `rebuild:electron` 还原 ABI。残留：`writeFlagDirect` frontend/src **空**、`callCli(` write_ops/draft **空**、`run_cli(` routers 仍 **4**（Python 未动）。
  - **测试改动**：write_ops/compose_draft.test 重写（删 argv builders/composeArgs，改测 daemon forwarder mock daemonRequest + flagBody + ApiError envelope）；backend_lifecycle.test「CF_AUDIENCE 前置」describe 语义反转（空 CF→现在 spawn）；新增 daemon_api.test（baseUrl/token header）+ http_client.test（headers 合并）；**删** write_ops_outbox_parity.test.ts（TS 不再直写 outbox → B1 的 TS 端字节契约失去意义；Python 侧 test_outbox_parity.py 保留）。
  - **dev 模式注记**：`pnpm dev`（app.isPackaged=false）BackendLifecycleManager 不接管 → serve-api 靠用户手动 pm2 起；dev dogfood 写前需手动 `mailagent serve-api`，否则写抛 E_NETWORK（诚实降级，读仍 IPC 直读）。打包态 flip 后自动起。
  - **独立 review（code-reviewer subagent，opus）**：**APPROVE WITH NITS**，0 Critical/0 High/0 Medium，7 核查项全 PASS（forwarder parity 逐项对 HttpApi + 实跑 Python `routers/{email,llm}.py` / pin 返完整 data 块→ElectronApi.pin `data?.is_pinned` 对得上 / flag 单行断点 chat 工具 + BatchActionBar 已适配、其余 flag 消费者只 await / token main-only + header 顺序安全 + auth.py 守卫确放宽 `not _LOCAL_API_TOKEN` 无 CF 不 import-crash / envelope 三分支 admin-calendar 仍 CliError 不受影响 / 残留 writeFlagDirect 0·callCli 0·run_cli 4 / 删 outbox_parity 正确 Python `test_outbox_parity.py` 保留）。2 LOW（notion:updateFlag 语义变化 dormant→**已补注释** / daemon_api↔backend_lifecycle 8200 重复=已文档化 tradeoff 无需改）+ 2 NIT（registry arrow-paren=formatter 合规修正[prettier 默认 always]保留 / email:pin `_opts` underscore 故意 signature-compat）。确认全程只读、git 工作树未污染。
  - **next-phase handoff → D2**（D1 收官；A+B+C+D1 全完成，剩 D2 最终验收 + 文档）：
    - **D2**：① backfill builder 从 `cli/commands/backfill.py` 正式下沉（C1 lazy 复用转正式）；② 读路径 wire-shape 去重（`routers/email.py` 的 `_meta_to_dict` 等抽 `services/wire.py`，CLI 同名 helper 改调）；③ 能力矩阵 100% 绿（含 batch_resync jobs API 前端接线：前端经 `POST /api/jobs` 起长任务 + `GET` 轮询 + `job.*` SSE，events_bridge 接线 —— 这是矩阵唯一剩的 `⬜`）；④ 性能基线前后对比（serve-api 写 ~500ms→几十 ms）；⑤ 端到端每写操作 CLI/本地 Electron/远程 web 各实跑；⑥ CLAUDE.md 文档地图 + `docs/claude/` 服务层架构文档 + 本看板归档。
    - **D1 复用点**：`daemon_api.daemonRequest`（D2 jobs API 前端接线复用）；`http_client.headers` 注入；`serveApiEnabled` flip（serve-api 恒本地写面）。**前瞻注记**：dev 模式需起 serve-api 才能写（见 dev 模式注记），D2 端到端验收时本地 Electron 测试需确保 serve-api 在跑。

- **D2a（✅ 完成）** `feat/backend-service-layer`：D2 拆分后第一段 = 后端代码下沉（纯后端、行为保持、有 parity 网）。
  - **D2 拆分裁定（用户拍板）**：D2 看板原列 6 项实测 = 3 个 session 量级 —— 子项③前端 batch_resync 是**从零新增**（jobs client + `job.*` SSE + UI 入口 + 真机验证，当前前端零 jobs 接线）；子项④⑤需真实 serve-api/Notion/davmail/邮箱（本 session 无法诚实执行，也不应真发邮件/改生产 Notion）。故拆：**D2a**(后端下沉 ①②, 本 phase) / **D2b**(前端接线 ③) / **D2c**(验收④⑤ + 文档⑥)。
  - **① backfill builder 下沉**：新建 `src/sync/backfill_builders.py`（engine 层），把 23 个 transport-neutral builder（dead-table helpers + body `_pick_candidates`/`_make_body_units`/`_backfill_one_body` + derivative `_find_candidates`/`_make_derivative_units`/`_insert_derived` + metadata `_pick_metadata_candidates`/`_make_metadata_units`/`_backfill_one_metadata`±applescript 等）**整段搬迁逐字节不改**（reviewer AST 验证 23 函数源码段相等）。`cli/commands/backfill.py` 删 727 行 → 顶部 import 下沉模块（命令体 / render / auth / target 适配器保留）；`sync/job_runners.py::run_backfill_job` 把 `from src.cli.commands import backfill` 改 `from src.sync import backfill_builders`（**消除 C1 遗留的 lazy sync→cli 反向 import**）。
  - **下沉目标 = `src/sync/`（非 plan/C1 注释字面的 `src/services/`）= 关键决策**：理由 —— builder 是 sync-engine 的「取数 + 重 IO 执行单元」(sqlite/AppleScript/office convert/写库)，与 fanout/job_runners 内聚；放 sync 既消 sync→cli 又保 `src/services/` 纯净（只放写操作编排 + 守卫）。C1 硬不变式「services 零 cli import」完全满足（backfill_builders 零 cli import）。reviewer 认同。
  - **② 读 wire 去重**：新建 `src/services/wire.py` 单一真源（`meta_to_dict`/`body_summary`/`attachment_to_dict`/`meta_record_to_list_item`），收编原 3 处手抄（`cli/commands/email.py` + `cli/commands/attachment.py` + `api/routers/email.py`）。**两处故意差异参数化保各端字节序**：① `meta_to_dict(include_important=False)` —— CLI email get 18 字段 / API GET 19 字段(末尾追加 `is_important` 给前端 EmailDetail)；② `attachment_to_dict(include_internal_id=False)` —— email get 内嵌 11 字段(gotcha #1 无 internal_id/local_path) / attachment list 12 字段(internal_id 紧跟 id 保字节序)。`folder.py::_attachment_to_dict`(接 dict 非 record, 结构不同) 不并入。
  - **验收**：`pytest tests/cli tests/api` = **717 passed, 1 failed**（=708 基线 + 新增 test_wire_parity 9；唯一 failed = 预存 env-coupled `test_resolve_allowed_email`，与 D2a 无关，未碰 auth.py）；test_schema_contract 全绿（读形状零漂移）；test_backfill + test_job_parity + test_async_jobs + test_job_worker + test_jobs_api = 45 passed（下沉行为 parity）。新增 `tests/cli/test_wire_parity.py`(9：golden 字段 + 字节序 + 两参数分叉 + gotcha#1 + None 边界)。`test_backfill.py` 改 5 处 `build_storage_payloads` patch target → `src.sync.backfill_builders`（`_backfill_one_body` 下沉故 caller 不在 backfill 模块；其余 AppleScriptArm/EmailReader/EmailRepository/_find_candidates patch 因 caller 仍在 backfill 模块 / 类方法 patch 不改）。ruff 全绿。**未碰前端**（Python-only）。
  - **残留**：`run_cli(` routers 仍 **4**（D2a 不动写端点 fork）；`src/sync/backfill_builders.py` + `src/services/wire.py` 零 cli import；job_runners backfill sync→cli **= 0**；三 caller 本地 wire helper def 清零。
  - **坑**：再次踩 ruff-autofix 删 import —— 先加 `from src.services import wire`（调用点尚未改）→ PostToolUse ruff autofix 当 unused 删掉 → 改完调用点后 F821；解法 = 调用点先改好(wire 已被引用)再重加 import 即留住。
  - **独立 review（code-reviewer subagent, opus）**：**APPROVE**，0 Crit/0 High/0 Med，两高危 claim 机械验证（下沉 23 函数 AST 逐字节相等 / 6 wire 投影 runtime 匹配 golden key 序含两参数分叉 + gotcha#1）；分层不变式 grep 确认；确认全程只读未碰 git。2 doc-only nit（wire.py 注释路径 tests/services→tests/cli **已修** / 参数化不对称是 baseline-justified 故意）。
  - **next-phase handoff → D2b**（D2a 收官；剩 D2b 前端接线 + D2c 验收文档）：
    - **D2b**（前端 batch_resync jobs API 接线，= 能力矩阵唯一剩的写操作 `⬜`）：前端**从零新增** —— `daemon_api.daemonRequest`(D1 已建) 调 `POST /api/jobs`(C1 端点) 起长任务 + `GET /api/jobs/{id}` 轮询 + `events_bridge.ts` 接 `job.*` SSE(C1 JobWorker 发) + UI 入口(选中多封 → 起 resync job → 进度)。涉及 UI **必真机/Playwright 验证**；改前端 → 跑 `cd frontend && pnpm test`。
    - **D2c**（最终验收 + 文档归档）：④ 性能基线(serve-api 写 ~500ms→几十 ms，需起 serve-api 实测) + ⑤ 端到端每写操作 CLI/本地 Electron/远程 web 各实跑(需真实 Notion/davmail/邮箱凭证) + ⑥ CLAUDE.md 文档地图加「服务层架构」指针 + `docs/claude/` 新建服务层架构文档 + 本看板归档 + 能力矩阵 100% 绿终判。
    - **D2a 复用点**：`backfill_builders` 已正式下沉(D2b 若需直接 import)；`wire.py` 投影(D2c 文档可引为「读形状单一真源」范例)；`test_wire_parity` golden 模式。

- **D2b（✅ 完成）** `feat/backend-service-layer`：前端 batch_resync jobs API 接线（选中多封 → 起 async_jobs resync 长任务 → 看进度）。**纯前端 phase，后端零改动**（C1 的 `POST /api/jobs` + `GET /jobs/{id}` + `job.*` SSE 全就绪）。**能力矩阵唯一剩的写操作 `⬜` 点亮 → 写操作 100% 绿**。
  - **设计发现**：项目早有完整 UI 占位 —— i18n `batchbar.resync`(「重传 Notion」) + `batchToast.{running,ok,partial,cancelled}`(零消费者) + Toast 的 long-task progress 机制(`push({progress})` → 进度条 + sticky，注释点名 BatchActionBar)。D2b = 把这套早规划的 UI 接到 C1 后端 → **零新增 i18n key**。
  - **两路客户端（daemon_api mirror 约束）**：`EmailApi.batchResync(internalIds, opts)` + `JobsApi.get(jobId)` 加进 `types.ts`(MailApi.jobs) / `ElectronApi.ts`(ElectronJobsApi) / `HttpApi.ts`(jobs 对象)；`write_ops.ts` 加 `runBatchResync`/`runGetJob` forwarder + `email:batchResync`/`jobs:get` IPC handler。wire **逐字段一致**：`POST /jobs {jobType:'resync', targetKind:'batch', targetKey:String(len), params:{internal_ids, replace_existing, skip_parent_lookup}}`(camelCase 信封 + snake_case params，对齐后端 `_resolve_resync_ids` 读 params.internal_ids)。replace_existing 默认 true(实跑重传，与单封 resync UX parity)；不传 idempotencyKey(每次新 job，允许重跑同批)。write_ops.test 锁 Electron forwarder wire，HttpApi 注释 mirror + 同 `EmailApi.batchResync` 签名(沿用 D1 模式)。
  - **进度 watcher（`src/shared/state/resyncJob.ts` 新，核心）**：`watchResyncJob` fire-and-forget，**不依赖 React 组件生命周期**(闭包持 mailApi/queryClient/toast store，用户退批量模式 / BatchActionBar unmount 仍跑到终态)。一个 sticky progress toast + 两路进度源：① SSE `job.*`(Electron: events_bridge 已转发全部 mailagent 事件，无需改 main 层；web: HttpApi.events.onEvent no-op 静默) ② GET `/jobs/{id}` 轮询(两端兜底: web 无 SSE 靠它拿终态 / Electron SSE 断线兜底)。`settled` 闸防 SSE×轮询双 finish + 互相 cleanup；轮询 reject 不终结(继续重试)；`MAX_WATCH_MS`(15min) 自毁兜底防永不终态泄漏；job_id 过滤防串扰。终态 5 路映射(succeeded→`batchToast.ok` / partial_failure→partial / failed-with-summary→partial / failed-runner-crash→`toolbarToast.resyncFailGeneric`+error detail / aborted→cancelled)对齐后端 `job_worker.py` 两形状 `job.failed`。
  - **UI**：BatchActionBar 加「重传 Notion」按钮(RefreshCw，byte-identical 既有 markRead/archive 等按钮)；`runResyncBatch` 起 job 拿 job_id → `watchResyncJob` 接管(enqueue 本身失败才在此 toastError)。
  - **验收**：typecheck(node+web) 0 error；`pytest tests/cli tests/api`=**718 passed 全绿**(零后端改动零回归；test_schema_contract + test_job_parity 含其中)；前端 D2b 测试 **31 passed**(write_ops +3 forwarder wire 断言 / 新 `resyncJob.test` 9: progress/终态 5 路/job_id 过滤/轮询兜底/reject 重试)；全量前端 **1287 passed**，9 failed 全是预存 `EmailRow.test.tsx` i18n(与 D2b 无关，C1/C2/D1 基线一致)；better-sqlite3 ABI 已还原。残留：batchResync 接线 types/ElectronApi/HttpApi/write_ops 各 ≥1 + watchResyncJob 2 文件 + `run_cli(` routers 仍 **4**(零后端改动)。lint：D2b 6 源文件 0 error(余 1 = email:pin `_opts` 预存，非 D2b)。
  - **独立 review（code-reviewer subagent, opus）**：**APPROVE WITH NITS**，0 Crit/0 High/0 Med。对照后端源码逐项验证 wire 两路 byte-for-byte 一致 + SSE 5 路终态映射全对 + watcher 生命周期(尝试构造 SSE/轮询双 finish 与 in-flight-poll-after-cleanup 泄漏，均正确闭合) + IPC 边界校验。**2 NIT 已收**：runner-crash 文案 → `toolbarToast.resyncFailGeneric`(本地化 zh/en) / `targetKey` informational 注释。**1 LOW 不修(out of D2b scope)**：sticky progress toast 在 ≥4 toast 涌入时被 `MAX_VISIBLE` 降级挤掉 = **预存 toast store 限制，非 D2b 引入**，happy path 不受影响(已 spawn_task 标记 toast.ts 豁免 progress toast 降级)。确认全程只读未污染 git。
  - **next-phase handoff → D2c**(D2b 收官；**A+B+C+D1+D2a+D2b 全完成，写操作 100% 绿**，剩 D2c = 最终验收 + 文档)：
    - **D2c**：④ 性能基线(serve-api 写 ~500ms→几十 ms，需起 serve-api 实测) + ⑤ 端到端每写操作 CLI/本地 Electron/远程 web 各实跑(需真实 Notion/davmail/邮箱凭证 + 真机；batch resync 走 Playwright/真机选多封点「重传 Notion」看进度 toast) + ⑥ CLAUDE.md 文档地图加「服务层架构」指针 + `docs/claude/` 新建服务层架构文档 + 本看板归档 + 能力矩阵 100% 绿终判(写操作已全绿，D2c 补验收 gate 的性能/e2e/文档 checkbox)。
    - **D2b 复用点**：`watchResyncJob` 进度 watcher 范式(未来 backfill UI 直接复用 jobs API + watcher)；两路 wire mirror + `write_ops.test` 锁形状；`MailApi.jobs` 已就位。**LOW 待办**：sticky progress toast 豁免 `MAX_VISIBLE` 降级(toast.ts，独立小任务)。
