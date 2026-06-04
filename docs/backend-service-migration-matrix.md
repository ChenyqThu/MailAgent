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
| set_flags（flag/read/状态） | ✅ A2 | ✅ A2 | ✅ A2 | TS 直写→⬜ D1 | ✅ 已存在 | ✅ A2 |
| resync | ✅ A2 | ✅ A2 | ✅ A2 | 🍴→⬜ D1 | ✅ 已存在 | ✅ A2 |
| archive | ✅ A3 | ✅ A3 | ✅ A3 | 🍴→⬜ D1 | ✅ 已存在 | ✅ A3 |
| pin / unpin | ✅ A3 | ✅ A3 | ✅ A3 | 🍴→⬜ D1 | ✅ 已存在 | ✅ A3 |
| llm_run | ✅ A3 | ✅ A3 | ✅ A3 | 🍴→⬜ D1 | ✅ 已存在 | ✅ A3 |
| compose_draft | ✅ A4 | ✅ A4 | ✅ A4 | 🍴→⬜ D1 | ➖<br>(无独立 schema) | ✅ A4 |
| send | ✅ A4 | ✅ A4 | ✅ A4 | 🍴→⬜ D1 | ➖<br>(无独立 schema) | ✅ A4 |
| compose_plan（dry-run） | ✅ A4 | ✅ A4 | ✅ A4 | 🍴→⬜ D1 | ➖<br>(无独立 schema) | ➖ |
| draft 创建（AppleScript） | ➖ host-local | ➖ | ⬜ D1 `POST /api/drafts` | shell fork 保留<br>（emergency 回切） | ➖ | ➖ |
| **长任务** batch_resync | ⬜ C1 job | ✅ LongTaskContext | ⬜ C1 `POST /api/jobs` | ⬜ D1 | ✅ 已存在 | ⬜ C1 |
| **长任务** backfill_body/deriv | ⬜ C1 job | ✅ LongTaskContext | ⬜ C1 `POST /api/jobs` | ➖ 运维 | ✅ 已存在 | ⬜ C1 |

## 读路径（保留直读，仅追 wire-shape parity）

> 决策：本地 Electron 读保留直读 SQLite（read-replica 快路径，4ms），不收编进 daemon。
> 只需保证「TS 直读形状」「Python EmailRepository 形状」「serve-api 端点形状」三者一致。

| 读操作 | Electron 直读(TS) | EmailRepository(Py) | serve-api 端点 | wire-shape 去重 |
|---|---|---|---|---|
| list / list_enriched | ✅ | ✅ | ✅ | ⬜ D2 抽 `services/wire.py` |
| get / body | ✅ | ✅ | ✅ | ⬜ D2 |
| search(FTS5) | ✅ | ✅ | ✅ | ⬜ D2 |
| mailboxes / thread / snippets / ai_fields | ✅ | ✅ | ✅ | ⬜ D2 |
| attachment list / download | ✅ | ✅ | ✅ | ⬜ D2 |
| calendar / folder | ✅ | ✅ | 🟡 骨架 | ⬜ D2 |

## 横切基础设施

| 项 | 状态 | 阶段 |
|---|---|---|
| ServiceError 体系（transport-neutral）+ CODE_TO_EXIT | ✅ | A1 |
| guards：Actor + require_write_auth + check_pm2_conflict | ✅ | A1 |
| ServiceContext / ServiceDeps | ✅ | A1 |
| outbox merge 原子 SQL + JS/Py 契约测试 | ✅ | B1 |
| async_jobs 表 + JobWorker（挂 serve） | ⬜ | C1 |
| 双层鉴权（本地 token + CF Access）+ SSE 9200 鉴权 | ⬜ | C2 |
| serve-api 崩溃自拉起 + 断路器 | ⬜ | C2 |
| 前端统一 http_client 写路径 | ⬜ | D1 |

## 残留检测（每阶段末跑，应为「预期内」或空）

```bash
# A2-A4 推进中：serve-api router 里还在 fork CLI 的写端点（目标逐步归零）
grep -rn "run_cli(" src/api/routers/ | wc -l        # 基线 12 → A2 后 10 → A3 后 7 → A4 后 4（消 email
                                                    # draft/send/draft-plan 各 1）；余 4 = admin 2
                                                    # + email 1（legacy notion update-flag）+ llm 1
                                                    # （selftest 读命令，不烧 token）。A 系列 fork 已清零，
                                                    # 余 4 全是 D1/后续阶段目标（非 compose）
# D1 后：前端 TS 直写 outbox 应消失
grep -rn "writeFlagDirect" frontend/src/            # D1 后应为空
# D1 后：前端 fork CLI 写应消失（保留 draft.ts 的 AppleScript emergency fork）
grep -rn "callCli(" frontend/src/electron/main/handlers/write_ops.ts   # D1 后应为空
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
