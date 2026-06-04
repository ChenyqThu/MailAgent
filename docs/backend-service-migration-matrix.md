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
| archive | ⬜ A3 | 🍴→⬜ A3 | 🍴→⬜ A3 | 🍴→⬜ D1 | ✅ 已存在 | ⬜ A3 |
| pin / unpin | ⬜ A3 | 🍴→⬜ A3 | 🍴→⬜ A3 | 🍴→⬜ D1 | ✅ 已存在 | ⬜ A3 |
| llm_run | ⬜ A3 | 🍴→⬜ A3 | 🍴→⬜ A3 | 🍴→⬜ D1 | ✅ 已存在 | ⬜ A3 |
| compose_draft | ⬜ A4 | 🍴→⬜ A4 | 🍴→⬜ A4 | 🍴→⬜ D1 | ✅ 已存在 | ⬜ A4 |
| send | ⬜ A4 | 🍴→⬜ A4 | 🍴→⬜ A4 | 🍴→⬜ D1 | ✅ 已存在 | ⬜ A4 |
| compose_plan（dry-run） | ⬜ A4 | 🍴→⬜ A4 | 🍴→⬜ A4 | 🍴→⬜ D1 | ✅ 已存在 | ➖ |
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
| outbox merge 原子 SQL + JS/Py 契约测试 | ⬜ | B1 |
| async_jobs 表 + JobWorker（挂 serve） | ⬜ | C1 |
| 双层鉴权（本地 token + CF Access）+ SSE 9200 鉴权 | ⬜ | C2 |
| serve-api 崩溃自拉起 + 断路器 | ⬜ | C2 |
| 前端统一 http_client 写路径 | ⬜ | D1 |

## 残留检测（每阶段末跑，应为「预期内」或空）

```bash
# A2-A4 推进中：serve-api router 里还在 fork CLI 的写端点（目标逐步归零）
grep -rn "run_cli(" src/api/routers/ | wc -l        # 基线 12 → A2 后 10（flag 两端点共用一个 helper，
                                                    # 故 resync+flag 实际只消 2 个 call-site，非估的 ~5）；
                                                    # 余 10 = admin 2 + email 6（archive/draft/send/draft-plan/
                                                    # pin + legacy notion update-flag）+ llm 2；A4 后仅剩 long-task
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
