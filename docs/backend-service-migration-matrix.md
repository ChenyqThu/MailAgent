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
| set_flags（flag/read/状态） | ⬜ A2 | 🍴→⬜ A2 | 🍴→⬜ A2 | TS 直写→⬜ D1 | ✅ 已存在 | ⬜ A2 |
| resync | ⬜ A2 | 🍴→⬜ A2 | 🍴→⬜ A2 | 🍴→⬜ D1 | ✅ 已存在 | ⬜ A2 |
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
grep -rn "run_cli(" src/api/routers/ | wc -l        # A2 后应减少 ~5；A4 后仅剩 long-task
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

- **A1（✅ 完成待 green-gate 确认）** `feat/backend-service-layer`：新建 `src/services/{__init__,errors,guards,context}.py`；`cli/exceptions.py` 改 `CliError(ServiceError)` + `CODE_TO_EXIT`；`cli/pm2_check.py` 退化 shim；`cli/output.py::emit_cli_error` 加 exit_code 回填。CliContext **零改动**（保 `ctx._sync_store` 注入）。
