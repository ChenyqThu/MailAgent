# MailAgent 4.1 架构优化与质量收口总纲

> **日期**：2026-11-22 · **基线提交**：`9acf0130`（4.0 架构瘦身 Wave 0–3 + 独立复核收口完成后） · **Trellis Epic**：`11-22-architecture-slimming-4-1-epic`
> **前序基线**：[`docs/plans/architecture-slimming-4.0/README.md`](../architecture-slimming-4.0/README.md) · [`v4-architecture-quality-review.md`](../../archive/2026-11/v4-architecture-quality-review.md)

## 0. 总体定位与推进策略

**核心判断**：4.0 架构瘦身（Wave 0–3）已将最重的公共巨石与跨端双跳清理大半，但全仓独立深查暴露出五类「隐性真缺陷、未封死边界与高频新热点」：数据库安全网存在真实盲区（`agent_config.db` 实测 `delete` 锁模式、`ai_chat.db` 无日常备份校验）、CI 缺少 `typecheck`/`ruff`/`artifact-server` 硬闸且 ESLint Prettier 噪音掩盖了 182 条真实 React 19 Hook 警告、`SuccessEnvelope[T]` 运行时校验被 `JSONResponse` 绕过、Typed IPC 边界回退（`shared/` 17 处碰 `window.electron`）、以及 `connector`/`agent`/`chat`/`CommandPalette`/`inspector` 等高频改动热点。

**推进策略**：分 **Wave 4（4A 止血与安全网 → 4B 契约真校验与 Router SQL 清零 → 4C 单写收口与 Typed IPC 边界）→ Wave 5（5A 后端高频热点拆分 → 5B AI Gateway 精修与记忆重试 → 5C 前端热点拆分与 React Hook 清零）** 小步推进，每波独立过闸并提交。

> **明确在范围之外的并行运营轨**：**P0-4（DavMail EWS → O365Graph 切流与自助重连）** 由 `.trellis/tasks/09-28-davmail-graph-cutover` 与 `10-28-davmail-self-reauth` 独立推进，本规划不改动生产 DavMail/OAuth 配置。

---

## 1. 4.1 基线数据（2026-11-22 · `9acf0130`）

| 维度 | 4.1 起点实测（`9acf0130`） | 目标状态 |
|---|---:|---|
| Python 后端 `src/` | 455 文件 / 184,059 LOC（`≥1,500` 行 17 个） | `ruff check src` 0 错进 CI；高频胖路由/store 拆解 |
| FastAPI Routers | 35 路由 / 453 端点 / **33 处 `.execute()`** | Router 裸 SQL **0 处** + 测试锁死；核心域真 `response_model` 校验 |
| `SuccessEnvelope[T]` 有效校验 | 27 个声明但均返回 `JSONResponse`（运行时被绕过） | `success_payload(...)` 返回 dict，校验真生效 + 扩面 + OpenAPI→TS 试点 |
| SQLite WAL 与安全网 | `agent_config.db` 实测 `journal_mode=delete`；`ai_chat.db` 无日常 `db_safety` | 5 个用户 DB 全为 WAL；`ai_chat.db` 纳入 `run_startup_db_safety`；删死 `getWriteDb()` |
| `sync_store.db` Electron 写者 | 1 处活跃直写（`handlers/translate.ts`）+ 死代码 `getWriteDb()` | **0** 写连接（翻译迁至 `ai-gateway` + `serve-api`），结构闸锁死 |
| Electron IPC & `shared/` 边界 | 86 条具名 IPC 通道；`shared/` 17 个文件碰 `window.electron` | Typed IPC 契约层覆盖；`shared/` 仅 3 个边界文件外 0 裸调用 |
| 前端代码质量 & CI | `typecheck` 未进 `ci-test.yml`；ESLint **1,736 warnings**（1,548 Prettier + 188 真实）；`artifact-server` 未进 CI | CI 补齐三闸；ESLint `--max-warnings=0` + `react-hooks/*` 恢复 `error` |
| `ai-gateway` & Agent 表单 | `domainClient` 6 层继承塔；`policy.ts` 1,003 行（90d 15 改）；`useCustomAgentForm` 49 `useState`；`captureTurnMemory` 无重试 | 组合替代深继承；`policy` 拆分；表单状态收敛；5xx 退避重试 |

---

## 2. 五大待治理架构病灶

1. **数据库安全网与并发隐患（P0-2）**：
   - `AgentConfigStore` 与 `LlmProviderStore` 文档宣称 WAL 并发安全，但 `_connection()` 从未执行 `PRAGMA journal_mode=WAL`，实测 `data/agent_config.db` 运行在 `delete` 排他锁模式。
   - `ai_chat.db` 是唯一未纳入 `run_startup_db_safety()`（`quick_check` + 24h 节流 `VACUUM INTO` 3 份滚动备份）的关键用户库；且 Python `src/chat/db.py` 使用 `timeout=5.0`，与 Electron 侧不一致。
   - `frontend/src/electron/main/db.ts` 残留零调用方的 `getWriteDb()`；`handlers/translate.ts` 仍在 Electron Main 直写 `sync_store.db`。
2. **CI 闸漏洞与 ESLint 告警遮蔽（P0-3）**：
   - `.github/workflows/ci-test.yml` 未跑 `pnpm run typecheck`、`ruff check src`（`src/` 存量 23 处违例），且未接入 `artifact-server`（4,163 LOC）。
   - `eslint --quiet .` 屏蔽了 1,736 条 warning，剥离 1,548 条 `prettier/prettier` 后暴露 **188 条真实缺陷**（`react-hooks/refs` 129 条中 `ResourceDrawer.tsx` 单文件占 65 条、`set-state-in-effect` 39 条、`exhaustive-deps` 14 条、无效 `eslint-disable` 6 条）。
3. **OpenAPI `SuccessEnvelope[T]` 运行时假校验与 Router 裸 SQL（P1-1 + P1-4）**：
   - `src/api/app.py::success_envelope` 返回 `JSONResponse`，导致 FastAPI 完全跳过 `response_model` 运行时校验；需引入返回纯 `dict` 的 `success_payload(...)` 并用静态闸防错用。
   - 7 个路由文件仍残留 33 处 `.execute()` 裸 SQL（`admin.py` 13、`email_views.py` 7、`llm.py` 4、`attachment.py` 3、`chat.py` 3、`email.py` 2、`ai.py` 1）。
4. **Typed IPC 缺口与 `shared/` 边界回退（P1-2 + P1-3）**：
   - `shared/` 目录下直接接触 `window.electron`/`ipcRenderer` 的文件从 3 个膨胀到 17 个；86 条 IPC 通道缺乏编译期契约表。
   - 邮件批翻译逻辑滞留 `handlers/translate.ts`，既阻止 `sync_store.db` 达成真·Python 单写，也令远程 Web `HttpApi.ai.translateBatch` 不可用。
5. **高频变更热点与 Wave 3 结构遗留（Wave 5 / P2）**：
   - 后端高频肥胖点：`connector.py`（2,033 行，30d 8 改）、`agent_config/store.py`（2,687 行，95 方法）、`agent.py`（2,053 行 / 58 路由）、`chat.py`（2,033 行）、`src/api/app.py`（30d 11 改）。
   - AI Gateway：`domainClient` 6 层无关域继承链、`tools/policy.ts`（1,003 行，90d 15 改）、`useCustomAgentForm.ts`（49 `useState`）、`captureTurnMemory` 上游 502 无重试静默丢记忆。
   - 前端高频热点：`CommandPalette.tsx`（2,030 行，90d 8 改）、`deriveSessionWorkspace.ts`（1,099 行，30d 6 改）。

---

## 3. 演进波次与验收门禁

### Wave 4A：P0 安全网、SQLite 并发修复与 CI/Lint 闸（P0-1 ~ P0-3）
- **4A.1 SQLite 安全网**：`AgentConfigStore`/`LlmProviderStore` 启用 WAL + `busy_timeout=30000`；`ai_chat.db` 接入 `run_startup_db_safety` 并对齐 `src/chat/db.py` WAL/timeout；删除死代码 `getWriteDb()`。
- **4A.2 CI 闸与 Lint 显性化**：清零 `src/` 23 处 Ruff 违例并在 `ci-test.yml` 补齐 `ruff check src`、`pnpm run typecheck` 与 `artifact-server`；`eslint.config.mjs` 关闭 `prettier/prettier` 噪音规则，清理 `ResourceDrawer.tsx` 65 条 ref 告警与 6 条无效 `eslint-disable`。

### Wave 4B：FastAPI 运行时真校验 + Router 裸 SQL 清零（P1-1 + P1-4）
- **4B.1 `SuccessEnvelope[T]` 真校验**：新增 `success_payload(...)` 切换 `contacts` 27 端点 + 扩面 `ai`/`notifications`/`folder`/`history_sync`；新增禁止 `response_model` 路由返回 `JSONResponse` 的 AST 闸；试点 `json-schema-to-typescript` 编译验证。
- **4B.2 Router 裸 SQL 清零**：将 `admin`/`email_views`/`llm`/`attachment`/`chat`/`email`/`ai` 共 33 处 `.execute()` 全部下沉至 repository；新增 `tests/config/test_no_router_raw_sql.py` 永久防回流。

### Wave 4C：邮件翻译收口 HTTP/Gateway + Typed IPC 边界（P1-3 + P1-2）
- **4C.1 翻译单写收口**：Python `TranslationRepository.save_segments_guarded` + `PUT /api/ai/translation/{id}`；批翻译迁入 `ai-gateway/routes/translateRoutes.ts` 并经 `ai_gateway_proxy.py` 暴露，打通 `HttpApi` 与 `ElectronApi`，删除 `handlers/translate.ts` 并加 `syncStoreReadonlyGate.test.ts` 锁死主进程对 `sync_store.db` 零写连接。
- **4C.2 Typed IPC 契约层**：建立 `shared/ipc/{contract,client}.ts` + `electron/main/ipc/typedHandle.ts`，迁移 15 个越界 `shared/` 文件，新增 `ipcBoundaryGate.test.ts` 禁止边界外裸用 `window.electron` / `ipcRenderer`。

### Wave 5：高频热点拆解、AI Gateway 精修与 React Hook 清零（P2-1 ~ P2-3）
- **5A 后端热点**：拆解 `connector.py`、`agent_config/store.py`、`agent.py`、`chat.py`，将 `src/api/app.py` 路由注册表驱动化。
- **5B AI Gateway 精修**：拍平 `domainClient` 6 层继承链为组合；拆分 `tools/policy.ts`；收敛 `useCustomAgentForm.ts` 49 处 `useState` 为 `useReducer`；`captureTurnMemory` 增加 5xx/网络错误有界退避重试。
- **5C 前端热点与 Hook 清零**：拆分 `CommandPalette.tsx` 与 `deriveSessionWorkspace.ts`；清零剩余全部 `react-hooks/refs`、`set-state-in-effect`、`exhaustive-deps` 告警并在 `eslint.config.mjs` 恢复 `error` 级别，达成 `eslint --max-warnings=0` 全绿。

---

## 4. 明确不做项（P3 边界护栏）

- **不拆“大但稳定”的冷文件**：`sync_store_migrations.py`、`sync_store.py`、`mail_write.py`、`davmail_backend.py`、`handlers/onboarding.ts`、`calendar.css`、`src/config.py`。
- **保留邮件只读 SQLite fast-path**：`handlers/email.ts` + `handlers/attachment.ts` 继续保留。
- **保留既定工具/兼容性护栏**：不删除 `frontend/package.json` 中的 `@lexical/*`（`@assistant-ui/react-lexical` peerDep）；保留 `handlers/admin.ts` 诊断导出 CLI、`handlers/onboarding.ts` 首次探测 CLI 及 `handlers/calendar.ts` 3 个 Notion 镜像旧 CLI；不做 Python→Node 大一统。

---

## 5. 阶段状态看板（实测指标回填）

| Wave | 主题 | 状态 | 核心指标前后对比（实测） |
|---|---|---|---|
| **Phase 0** | 4.1 路线图落盘 + 卫生态提交 | ✅ 已完成 | 4.1 总纲与 Trellis Epic 建档；收口 `test_reminder.py` 临时路径、`.gitignore` 与 `v4-architecture-quality-review.md` 归档，推齐 `origin/main` |
| **Wave 4A** | SQLite WAL/安全网 + CI 闸 + ESLint 去噪 | ✅ 已完成 | `AgentConfigStore`/`LlmProviderStore` 启用 WAL+30s `busy_timeout`；`ai_chat.db` 纳入 `run_startup_db_safety`（`ChatDb` 对齐 WAL/30s）；删除死代码 `getWriteDb()`；`ruff check src` 23→**0**；`ci-test.yml` 补齐 `ruff` + `typecheck` + `artifact-server`（8/8）；ESLint 关闭 `prettier/prettier` 噪音并修 `ResourceDrawer` 65 条 ref + 6 条无效 disable，warnings **1,736→117**（0 error；1,159 PY + 50 FE 文件/347 项全绿） |
| **Wave 4B** | `SuccessEnvelope` 真校验 + Router 裸 SQL 清零 | ✅ 已完成 | `contacts`(27)+`ai`/`notifications`/`folder`/`history_sync` 真 `response_model`；`check-openapi-contract.ts` 40 模型；Router `.execute()` 33→0；Ruff 0，`pytest` 3069 passed |
| **Wave 4C** | 翻译单写收口 + Typed IPC 边界 | ✅ 已完成 | 批翻译收口至 `ai-gateway/routes/translateRoutes.ts` + Python `PUT /api/ai/translation/{internal_id}` + `ai_gateway_proxy.py`；删除 `handlers/translate.ts` 与 `syncStoreReadonlyGate.test.ts` 守门；`shared/ipc/{contract,client}.ts` + `typedHandle.ts` 收口 15 个文件；Py `796 passed`、`vitest` 507/507 (6865)、`web`+`electron` build 全绿 |
| **Wave 5A** | 后端高频 Router & `AgentConfigStore` 拆解 | ✅ 已完成 | `connector.py` (2,033→71L)、`agent_config/store.py` (2,690→236L)、`agent.py` (2,053→58L)、`chat.py` (1,974→891L) 按领域拆分子模块并保留门面兼容；`app.py` 收敛为声明式 `_ROUTER_SPECS`；`ruff` 0 错误、`pytest` 3297 passed、`check-openapi-contract.ts` 41 模型通过 |
| **Wave 5B** | AI Gateway 组合化 / `policy` / 表单收敛 / 记忆重试 | ✅ 已完成 | `domainClient` 6 层继承拍平为 `DomainHttpCore` + 组合工坊；`tools/policy.ts` 拆出 `policyRules.ts` + `policyEval.ts`；`useCustomAgentForm.ts` 49 处 `useState` 收敛为 `useReducer` 且移除 `set-state-in-effect` 豁免；`captureTurnMemoryWithRetry` `[3s, 10s]` 退避重试 + `memory_capture_retry.test.ts`（7 项）；Vitest `149 文件 / 2,135`、Py `427 passed`、`validate_catalog` `119/119` 全绿 |
| **Wave 5C** | 前端热点拆解 + React Hook 警告清零拉闸 | ✅ 已完成 | `CommandPalette.tsx` 2,030→404 行（4 焦点模块）；`deriveSessionWorkspace.ts` 1,099→179 行（`Base`/`Artifacts`/`Sources`）；剩余 117 条 React Hook 警告清零、`eslint.config.mjs` 恢复 `error`、`ci-test.yml` 升级 `--max-warnings=0`；`eslint --no-cache --max-warnings=0 .` 0 错 0 警、`typecheck` / `build:web` / `electron-vite build` 全绿，核心 Vitest 348 文件 3295 通过 |

---

## 6. 全仓收口验证实测（2026-11-22）

在收口回归修复 [`0a901630`](https://github.com/chenyqThu/MailAgent/commit/0a901630) 之后执行全仓双端门禁（涵盖 Phase 0 `b7f9e3e0`、Wave 4A `774abc29`、Wave 4B `81c2e763`、Wave 4C `c00b7527`、Wave 5A `8d80c915`、Wave 5B `3ff66863`、Wave 5C `d291b8b2` 及收口修复 `0a901630`）：

| 验证项 | 命令 | 实测结果 |
|---|---|---|
| Python Lint | `./venv/bin/python -m ruff check src` | `All checks passed!`（0 错） |
| 全量 Python Pytest | `./venv/bin/python -m pytest tests/ -q --ignore=tests/agent_eval` | **9,222 passed**, 1 skipped（0 failed） |
| Agent Eval 回归网 | `./venv/bin/python -m pytest tests/agent_eval -q` | **187 passed** |
| Tool Catalog 对齐 | `./venv/bin/python tests/agent_eval/runner/validate_catalog.py` | `source_tools=119 catalog_tools=119 RESULT: OK` |
| OpenAPI → TS 契约 | `pnpm --dir frontend exec tsx scripts/check-openapi-contract.ts` | **41** `SuccessEnvelope_*` 模型编译并通过 `tsc`（1,538 行） |
| Artifact Server | `pnpm --dir artifact-server typecheck && pnpm --dir artifact-server test` | `tsc --noEmit` 0 错；**1 file / 8 passed** |
| 前端 Typecheck | `pnpm --dir frontend typecheck` | `typecheck:node` + `typecheck:web` + `typecheck:tests` 全过（`manual_compact_spike.test.ts` 债 1→0） |
| 前端 ESLint 硬闸 | `pnpm --dir frontend exec eslint --no-cache --max-warnings=0 .` | **0 errors, 0 warnings**（`react-hooks/refs` 与 `set-state-in-effect` 均已恢复 `error`） |
| 全量前端 Vitest | `pnpm --dir frontend test` | **760 files passed (760)**；**9,191 passed**, 1 skipped (9,192) |
| Web & Electron 构建 | `pnpm --dir frontend build:web && pnpm --dir frontend exec electron-vite build` | 双产物构建均退出 0（Electron Vite `built in 6.89s`） |
| Electron Native ABI | `pnpm --dir frontend rebuild:electron` | 最终步骤恢复 `better_sqlite3.node` 至 Electron 39.8.10 ABI 140 并签名 |

