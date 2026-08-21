# 后端服务层架构（统一写面 + 远程读面）

> **何时读**：改写操作（flag/resync/archive/pin/llm/compose/send/长任务）、加新传输端（CLI/serve-api/前端客户端）、动 `src/services/` 前。
> **配套**：设计方案 [`~/.claude/plans/cli-streamed-brook.md`](file://~/.claude/plans/cli-streamed-brook.md)（9 阶段序列 + 决策理由）· 执行/验收看板 [`docs/backend-service-migration-matrix.md`](backend-service-migration-matrix.md)（能力矩阵 operation×transport，每格绿才算 done）· 真机验收手册 [`docs/backend-service-e2e-runbook.md`](../ops/backend-service-e2e-runbook.md)。
> 本文件是**代码视角的权威导航**：plan = 为什么这么设计、看板 = 每阶段怎么落地的、本文 = **现在代码长什么样 + 怎么用/扩展**。

## 一句话

所有**写操作 / 计算**的「编排 + 守卫」下沉到 transport-neutral 的 `src/services/` 应用服务层；CLI（typer）与 serve-api（FastAPI）退化成「解析 → 调 service → 格式化」的薄适配器（in-process，**不再 fork CLI 子进程**）；前端写经 Electron Main 进程转发到本机 daemon。**领域类（NotionSync/OutboxRepository/LLMRunner/EmailRepository/SyncStore/backend）一行未动**。

状态（2026-06-04）：9 阶段 A1→D2c **全部完成**，能力矩阵**写操作 100% 绿**。

## 为什么（被消灭的问题）

改造前有 **4 条数据通道**写同一份状态，且「写编排 + 守卫」锁死在 CLI 命令体里 —— 别的传输想复用一个写操作**只能 fork `mailagent` 子进程**：

- 本地读 = Electron `better-sqlite3` 直读（~4ms）
- 本地写·简单 = 前端 `writeFlagDirect` 直写 `email_metadata`+`email_outbox`（merge 语义**手抄成一份 TypeScript**，与 Python `outbox.py` 两份真源）
- 本地写·复杂 = 前端 `callCli` **fork** `mailagent` 子进程
- 远程 / serve-api = FastAPI 读用 `EmailRepository` 进程内，但**写也 fork CLI**（`cli_runner.py`）

**真正的税不是认证**（`hmac.compare_digest` <1ms），是**每次 fork 一个新 Python 进程 + 重载配置与领域服务**。本次 dry-run 隔离基线实测（见下「性能基线」）：fork 一次 ≈ **759ms**，in-process 同编排 ≈ **3.75ms**，**~200x**。

## 目标分层架构（实际落地）

```
┌─ Clients ─────────────────────────────────────────────────────────┐
│ 本地 Electron:  读=直读 SQLite(4ms, read-replica 快路径, 保留不收编)   │
│                 写/计算=Main 进程转发 → 本机 daemon HTTP(127.0.0.1:8200)│
│ 远程 web/移动:  读+写 全走 daemon HTTP(经 cloudflared + CF Access)     │
│ CLI(一等公民):  薄适配器, in-process 调 service                       │
└────────────────────────────────────────────────────────────────────┘
            │ HTTP(envelope: status/data/error/meta) ── 双层鉴权 (C2)
┌─ Transports（薄适配器，不再 fork-as-reuse）─────────────────────────┐
│ serve-api FastAPI(8200)   CLI typer   async-jobs(POST /api/jobs)     │
└────────────────────────────────────────────────────────────────────┘
            │ in-process 调用 (await asyncio.to_thread(svc.method))
┌─ 应用服务层 src/services/（transport-neutral, 零 cli import）───────┐
│ MailWriteService(set_flags/resync/archive/set_pin/compose_*/send)    │
│ LlmService(run)   guards(Actor/require_write_auth/check_pm2_conflict)│
│ ServiceError(平移 CliError 去 exit_code)   ServiceContext(依赖容器)  │
│ wire(读形状投影单一真源: meta_to_dict/attachment_to_dict/...)        │
└────────────────────────────────────────────────────────────────────┘
            │ 编排（一行不改）
┌─ Domain（已存在，不动）────────────────────────────────────────────┐
│ NotionSync · OutboxRepository · LLMRunner · EmailRepository ·       │
│ SyncStore · backend(davmail/applescript)                            │
└────────────────────────────────────────────────────────────────────┘
            │ outbox / async_jobs SSoT
┌─ Sync engine (src/sync/, 挂 serve 进程) ───────────────────────────┐
│ FanoutWorker(拉 email_outbox→Mail.app+Notion)                       │
│ JobWorker(async_jobs 长任务执行器) · backfill_builders · job_runners│
└────────────────────────────────────────────────────────────────────┘
```

## 核心不变式（破坏即回归）

1. **SQLite 文件 = SSoT**；daemon = **唯一写面 + 远程读面**，但**不是唯一读面**（本地 Electron 直读 SQLite 是它独有的合法快路径，4ms→20ms 不值 + 保离线只读兜底）。
2. **`src/services/` 零 cli import** —— `grep -rn "from src.cli\|import src.cli" src/services/` 必须空。services 只放「写操作编排 + 守卫」；需要复用 `cli/long_task` 或重 IO builder 的东西放 `src/sync/`（engine 层），不污染 services。
3. **写面单一真源** —— 前端 `writeFlagDirect`（TS 手抄 merge）已删，写全走 daemon → service。outbox merge 是**单条原子 UPSERT**（`json_patch`，语义真源 = SQLite 引擎），不再有 JS/Python 两份手抄。
4. **守卫分工**：token 校验留**适配器**（CLI `require_auth` → exit 4 / serve-api dual-auth dependency）；`require_write_auth(actor)` + `check_pm2_conflict` 在 **service 入口**。dry-run / 业务校验早于 auth 的命令（compose）用 `authed`-bool 传入。
5. **AppleScript fallback 始终可用** —— `draft.ts` 保留直 fork `create_reply_draft.sh` 作 emergency 回切；shell artifact 进 bundle `extraResources`；AppleScript 路径绝不依赖 davmail/EWS/网络。

## `src/services/` 应用服务层

| 文件 | 职责 | 阶段 |
|---|---|---|
| `errors.py` | `ServiceError` 体系（平移 `CliError` 去掉 `exit_code`：ServiceAuth/NotFound/InvalidArg/LLMFailed…）。`cli/exceptions.py::CliError(ServiceError)` + `CODE_TO_EXIT` 回填 exit_code | A1 |
| `guards.py` | `Actor`（鉴权主体 kind/authenticated/label）+ `require_write_auth(actor)` + `check_pm2_conflict(allow_concurrent)`（搬 `cli/pm2_check.py`）| A1 |
| `context.py` | `ServiceContext`（依赖容器：lazy `sync_store`/`notion_sync`/`email_repo`/`backend`/`config`）+ `ServiceDeps` Protocol。outbox 从 `ctx.sync_store.db_path` 现取（未加 outbox 属性）| A1 |
| `mail_write.py` | `MailWriteService`：`set_flags`/`resync`/`archive`/`set_pin`・`set_pins`/`compose_draft`/`send`/`compose_plan` + 各 `plan_*`（dry-run 共享 CLI+serve-api）+ Result dataclass（字段逐字段对齐旧 emit data）| A2-A4 |
| `llm_service.py` | `LlmService.run`（搬 `llm_run` + LLMRunner 编排 + finally close）+ `_maybe_davmail_backend` | A3 |
| `wire.py` | 读形状投影**单一真源**：`meta_to_dict(include_important)`/`body_summary`/`attachment_to_dict(include_internal_id)`/`meta_record_to_list_item`。两参数化保各端字节序差异 | D2a |

**关键决策**（实际落地 vs plan 字面）：

- **serve-api `get_service_ctx()` 每请求新建**（非单例）—— NotionClient httpx 连接池绑首个 event loop，resync 走 `asyncio.run` 每次新 loop，复用会撞。代价 = 每请求重 `load_cli_config` + lazy deps（基线里 perreq 的 ~3.7ms 主要在此）。
- **config 访问**：service 经 `ctx.config`（CliContext 的 `cli_config` 别名）拿配置，**不读全局 `src.config.config`** —— 否则 `test_service_parity` 注入的 cli-scoped cfg 失效。
- **outbox `source` 硬编码 `'cli'`** 维持 parity（echo prevention 只特判 `notion_webhook`）。
- **`cascade_thread`（线程虚拟头级联，2026-08）**：`set_flags` / `set_pins` 的可选参数，服务端按 primary 的 `thread_id` 展开线程内成员一并收敛，**一次往返**（前端禁 N 次 IPC 扇出）。`set_flags`：只扩到**仍带旗**的成员且只写 `{is_flagged: False}`（不动它们的 `processing_status`）；`set_pins`：只扩到**仍置顶**的成员。两者都排除草稿箱（判定走 `mailbox_semantics`）、`thread_id` 为空不展开、且**只在收敛方向合法**（`is_flagged=False` / `pinned=False`，否则 `E_INVALID_ARG` 而非静默忽略）。级联到的 id 落 `FlagResult.cascade_ids` / `PinBatchResult.cascade_ids`，**不进** `updated_ids`／CLI emit data（`email-flag.schema.json` 是 `additionalProperties:false`），前端经 SSE 批量事件（`internal_id=None` + `data.internal_ids`）拿到全集。`email.pin_changed` 自此**恒走批量 wire**（单封写也一样，消费侧只认一种形状）。

## 9 阶段重构总览

| 阶段 | 内容 | 关键落地 |
|---|---|---|
| **A1** | 守卫/错误体系下沉 | `errors/guards/context.py`；CliContext 零改动 |
| **A2** | set_flags + resync | 首个可测收益；serve-api flag/resync fork→in-process |
| **A3** | archive + pin + llm_run | archive 保「Notion 失败仅 warn」；archive/pin 不做 pm2 |
| **A4** | compose draft/send/draft-plan | **A 系列收官（写 fork 清零）**；净简化删临时文件 `--body-html-file`；compose 用 authed-bool（业务校验先于 auth）|
| **B1** | outbox merge 原子 UPSERT | DB v19→v20 partial unique index + `json_patch`；消 JS/Py 两份手抄 merge；**D1 硬前置** |
| **C1** | async_jobs 长任务子系统 | DB v20→v21；`AsyncJobRepository` + `JobWorker`（挂 serve）+ `job_runners`；复用 `cli/long_task::LongTaskContext` + SSE 9200 |
| **C2** | 双层鉴权 + serve-api 自拉起 | 8200 dual-auth（本地 token + CF Access）+ 9200 SSE 门 + 崩溃指数退避重启 + 断路器 |
| **D1** | 前端写收编 daemon | **架构=Main 进程转发**（renderer 零改动，token 不进 renderer）；删 `writeFlagDirect`；写源 4→1 |
| **D2a** | 后端下沉 | backfill builder → `src/sync/backfill_builders.py`（消 sync→cli 反向 import）+ 读 wire → `services/wire.py` |
| **D2b** | 前端 batch_resync jobs 接线 | `daemon_api`→`POST /api/jobs` + `GET` 轮询 + `job.*` SSE + `watchResyncJob` 进度 toast + BatchActionBar「重传 Notion」|
| **D2c** | 性能基线 + 文档归档 | 本文档 + e2e runbook + 看板归档（**本阶段**）|

## 能力矩阵现状

**写操作 100% 绿**：set_flags / resync / archive / pin・unpin / llm_run / compose_draft / send / compose_plan / **长任务 batch_resync / backfill** —— 每个在 service / CLI 适配器 / serve-api in-process 端点 / Electron daemon 客户端 / schema 契约测试 / parity golden 六列全绿。

**唯一保留 ⬜**：`draft 创建（AppleScript）`的 serve-api `POST /api/drafts` = **非阻塞 backlog**（host-local GUI 能力，远程草稿走 IMAP draft + `compose_draft` 端点；`HttpApi.createDraft` notImplemented）。用户裁定 2026-06-04 不计入 D2 验收。

**读路径**保留直读（read-replica），仅追 wire-shape parity（D2a `services/wire.py` 收编 list/get/body/attachment 三处手抄）。

## 性能基线（dry-run 隔离 fork 税）

脚本 [`scripts/dev/benchmark_service_layer.py`](../../../scripts/dev/benchmark_service_layer.py)：三条路径跑**同一个** dry-run `plan_flags` 编排，`--dry-run` 不写 Notion/Mail/SQLite/outbox + 跳过 auth/pm2 → fork 税与真实 IO 干净解耦（临时库 + 假 env，**不碰生产库**）。

| 路径 | mean | p50 | p95 |
|---|--:|--:|--:|
| fork-cli（旧 serve-api `run_cli` 模型）| **758.5ms** | 660.8ms | 1684.9ms |
| inproc-perreq（新 serve-api 每请求新建 ctx）| **3.75ms** | 3.64ms | 4.65ms |
| inproc-warm（复用 ctx 纯编排下界）| 0.0005ms | 0.0005ms | 0.0005ms |

- **fork→in-process ≈ 200x**（759ms→3.75ms）。税的 99.5% 在「fork 进程 + 全量 import + 重载配置/服务」；编排本身（3.75ms→0.0005ms）才是真正的领域逻辑开销。
- 印证 plan 断言：**写慢不是认证，是每次 fork 进程**。fork 759ms > plan 估的 ~500ms，因这是完整 wall-clock（venv console script + 全量 import `src` 树 + typer 启动）。
- 重跑：`./venv/bin/python3 scripts/dev/benchmark_service_layer.py`（机器/负载不同数字会变，故**不作 CI gate**，仅基线参考）。

## 横切基础设施

- **双层鉴权（C2，`src/api/auth.py`）**：`verify_cf_access` 前置本地 token 腿 —— `X-MailAgent-Local-Token` `compare_digest` 匹配 → 本地身份；否则回落 CF JWT；都无 → 401 fail-closed。header/env 名三处手抄（`auth.py`/`sse_server.py`/`frontend/.../local_token.ts`）有契约测试钉死。token = Electron `randomBytes(32)` 单例，`buildBaseEnv` 注入 serve+serve-api 两进程。
- **SSE 9200 门（`src/sse_server.py`）**：`_stream_events` 首行早返回 401（redis/streaming 之前）；当前只做本地 token（9200 未 tunnel 暴露，远程 SSE 走 webhook-server 8100）。
- **serve-api 崩溃自拉起（`backend_lifecycle.ts`）**：指数退避 re-spawn（1→2→5→10→30s）+ crash-loop 断路器（`MAX_CRASH_RESTARTS=5`）。serve-api 保持软门控（不升级硬依赖）。
- **async_jobs（C1，`src/sync/`）**：长任务（batch_resync/backfill）不复用 outbox（outbox=字段级 merge intent；job=带 checkpoint/熔断/进度的过程）。`POST /api/jobs` enqueue 幂等（`ON CONFLICT(idempotency_key) DO NOTHING`）+ `GET /api/jobs/{id}` 查询 + `job.*` SSE 进度。执行进程 = **serve**（非 serve-api，长任务不依赖软门控端点）。
- **前端 daemon 转发（D1）**：`daemon_api.daemonRequest` 复用 web SPA 同款 `http_client.request` + 注入本地 token；`write_ops.ts` 6 forwarder + `draft.ts` 3 compose forwarder **mirror HttpApi**；renderer 走 IPC 零改动。
- **仪表盘读也走 daemon（task 08-20-perf-dashboards）**：`daemon_api.daemonRead`（GET + 传输层失败重试恰一次，**不回落 CLI**）接管 `llm:stats` / `kos:stats` / `admin:health` / `admin:stats` / `admin:deadLetterList` 五个读 IPC。此前它们每次取数 fork 一个 `mailagent`（Python 冷启 ~500ms-1s），且 `admin stats` 的 CLI 路径顺带跑 `SyncStore.__init__` 的 129 条 `CREATE IF NOT EXISTS` + 迁移梯 —— 每刷新一次看板就跟 mail-sync 抢一次写锁。`llm:selftest` **有意留在 CLI**（主动按钮、低频、30s gateway 往返）。配套：`GET /api/admin/stats` 补齐 `v4_rollout` / `outbox` 两段（组装体单源 `src/services/admin_stats.py`，CLI 同源），否则换传输端会让看板少两块卡。

## 关键文件地图

| 文件 | 角色 |
|---|---|
| `src/services/*.py` | 应用服务层（见上表）|
| `src/api/routers/{email,llm,jobs}.py` | serve-api 薄适配器；写端点 `await asyncio.to_thread(svc.method)` in-process |
| `src/api/auth.py` | 双层鉴权 dependency（47 router `Depends(verify_cf_access)` 零改动）|
| `src/cli/commands/{email,llm,backfill}.py` | CLI 薄适配器（解析 → 调 service → 格式化）|
| `src/sync/{async_jobs,job_worker,job_runners,backfill_builders}.py` | 长任务子系统 + backfill 下沉 |
| `frontend/src/electron/main/handlers/{write_ops,draft}.ts` | 前端写 forwarder（mirror HttpApi）；draft 保留 AppleScript emergency fork |
| `frontend/src/electron/main/{daemon_api,local_token,backend_lifecycle}.ts` | daemon 转发 + 本地 token 单源 + serve-api 生命周期 |
| `frontend/src/shared/state/resyncJob.ts` | `watchResyncJob` 长任务进度 watcher（未来 backfill UI 复用范式）|
| `tests/cli/test_service_parity.py` | service==旧 CLI golden（行为保持最强锚点）|
| `tests/cli/test_schema_contract.py` | 读形状零漂移锚点（全程必绿）|

## 残留检测不变式（每次改服务层后跑）

```bash
grep -rn "run_cli(" src/api/routers/ | wc -l                 # = 4（admin 2 = dead-letter retry/purge 运维端点 + email 1 = legacy update-flag + llm 1 = selftest；均非 A 系列消灭的通用写操作 fork）
grep -rn "from src.cli\|import src.cli" src/services/         # 空 (services 零 cli import)
grep -rn "writeFlagDirect" frontend/src/                      # 空 (写面单一真源)
grep -rn "callCli(" frontend/src/electron/main/handlers/write_ops.ts  # 空 (写已收编 daemon)
pytest tests/cli/test_schema_contract.py -q                  # 全绿 (data 形状零漂移)
```

## 验收状态

软件验收（本 session 已过）：能力矩阵写操作 100% 绿 · `pytest tests/cli tests/api` 绿（唯一预存 fail = env-coupled `test_resolve_allowed_email`，commit 1947642 后应已 hermetic）· `test_schema_contract` + 各 `parity golden` 绿 · 性能基线数字化 · 残留检测全绿。

**待真机验收（e2e ⑤，需真实 serve-api/Notion/davmail/邮箱 + 真机）** → 见 [`docs/backend-service-e2e-runbook.md`](../ops/backend-service-e2e-runbook.md)：每个写操作从 CLI / 本地 Electron / 远程 web 各实跑一遍 + `email_outbox` dead_letter / gt_30m pending 监控。**本 agent session 不真发邮件 / 不改生产 Notion**（不可逆 + 外发），故 e2e 留 runbook 给人执行。

## 迁移期回切 / 监控

- **回切**：每个写源用 env 旗标控「直写 vs 走 daemon」（`reverse_sync.py` 已有灰度先例）。outbox 是 append-only intent，写源可热切换、数据不丢。
- **量化回切判据**：监控 `email_outbox` `dead_letter` 计数 + `gt_30m` pending 堆积（`admin /stats` 已暴露）；突增即回切上一阶段。
- **B1 migration 注意**：bump `DB_VERSION` 必同步前端 `backend_lifecycle.ts::EXPECTED_DB_VERSION`（`db_version_consistency.test.ts` 兜底），见 [`packaging-release.md`](../packaging/packaging-release.md)。
