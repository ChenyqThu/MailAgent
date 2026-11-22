# MailAgent 4.0 架构瘦身与模块化收敛总纲

> **日期**：2026-11-21 · **基线版本**：`v4.0.0` · **Trellis Epic**：`11-21-architecture-slimming-4-0-epic`
> **前序基线**：[`docs/plans/architecture-review-2026-07/README.md`](../architecture-review-2026-07/README.md)（E0–E4 收敛规划）

## 0. 总体定位与推进策略

**核心判断**：v4.0 功能完整度和安全纵深很高，但经过五个月高频演进（代码量 2–6x 膨胀），出现了「**跨边界传输四世同堂 + 公共单文件巨石化 + 局部泥潭未解耦**」的问题。同时全仓已具备 **589 个 Python 测试文件 + 767 个前端测试文件 + 50+ 跨语言 parity 闸**，具备安全做渐进式收敛的工程底气。

**推进策略**：采用 **「轻量横切拆地雷（Wave 0–1）→ 按业务模块垂直切片瘦身（Wave 2）→ AI Chat 专项收口（Wave 3）」** 的组合打法：
- 先打牢公共地基与传输/样式/数据库边界，再逐个模块垂直清理，避免在公共巨石未解耦时多模块并行撞车。
- 全程小步可验证：每一批保持 100% 对外兼容性与测试/静态闸全绿。

---

## 1. 4.0.0 膨胀现状基线（对比 2026-07 v1.2）

| 维度 | 2026-07 (`v1.2`) | 2026-11 (`v4.0.0`) | 变化 |
|---|---:|---:|---|
| Python 后端 `src/` | 84.4k LOC（243 文件） | **183.3k LOC**（437 文件） | **2.2x** |
| 前端 `frontend/src/` | 102.4k LOC | **304.1k LOC**（1,529 文件） | **3.0x** |
| `ai-gateway/`（Node） | 5.9k LOC | **36.7k LOC**（82 文件） | **6.2x** |
| `sync_store.db` | `DB_VERSION = 29` | **`DB_VERSION = 75`**（47 表 + 8 FTS 虚表） | +46 次迁移 |
| `ai_chat.db` | — | **`CHAT_DB_VERSION = 33`** | Node/PY 双写 |
| FastAPI 路由规模 | 16 routers | **36 routers / 455 routes** | >2x |
| Electron IPC | ~118 channels | **152 handlers** | +29% |
| `src/config.py` / `.env.example` | ~140 字段 | **184 字段 / 217 env keys** | 持续膨胀 |
| 自动化安全网 | 181 前端测试 | **589 Python + 767 前端测试 + 50+ parity 闸** | 底座扎实 |

---

## 2. 五大系统级横切病灶

1. **传输与数据访问「四世同堂」**：
   - **终态直连 HTTP**：Matters、Library、Contacts 新接口、Connectors、Notifications、Chat 直连本机 `serve-api` loopback HTTP。
   - **无意义双跳（IPC → `daemon_api` → HTTP）**：`write_ops` / `folder` / `draft` / `today` / `admin` 等先过 Electron IPC，再由 `electron/main/daemon_api.ts` 转发本机 `serve-api`，迫使 `ElectronApi.ts`（1,082 行）与 `HttpApi.ts`（1,099 行）双份维护。
   - **Electron Main 直读 SQLite**：10 个 handler 文件共 35+ 处 `better-sqlite3` `.prepare()` 查询（`email.ts` / `calendar-read.ts` / `contacts.ts` / `attachment.ts` 等），需靠跨语言 SQL 镜像测试防漂移。
   - **遗留 CLI 子进程**：`calendar-write.ts`（6 处 `callCli`）、`report.ts`（5 处）、`admin.ts`（4 处）等仍在桌面端 fork Python CLI。
   - **`ai_chat.db` 跨语言双写**：Schema 归 `electron/main/chat_db/`（3.2k LOC），Python 侧另维护 `src/chat/db.py`（1,743 行）直连同一数据库文件。

2. **后端超级巨石 + Router SQL 回流**：
   - 核心巨石：`src/mail/sync_store.py`（8,327 行，全站 7 个域 DDL + 53 段内联迁移 + 邮件方法）、`src/matters/service.py`（6,415 行 / 157 方法）、`src/repository/email_repository.py`（5,212 行 / 145 方法）、`src/mail/new_watcher.py`（3,059 行）、`src/services/mail_write.py`（2,956 行）、`src/agent_config/store.py`（2,687 行）。
   - Router 边界失守：`chat.py`（2,186 行 / 40 路由）、`agent.py`（2,053 行 / 58 路由）、`connector.py`（2,033 行 / 37 路由）、`matters.py`（1,510 行 / 76 路由）；且部分路由直接写裸 SQL（`contacts.py` 40 处、`admin.py` 29 处、`email_views.py` 18 处）。

3. **AI Chat & Agents 体量最大（174k LOC）且包揽高频修改**：
   - 全栈占比近 40%，`ai_gateway_lifecycle.ts`（2,422 行）、`ai-gateway/server.ts`（2,539 行）、`domainClient.ts`（2,824 行）、`tools/schemas.ts`（2,334 行）与 `chatRun.ts`/`agentRun.ts`/`groupOrchestrator.ts` 三条流控管线高度耦合；前端分散在 `shared/assistant/`、`components/agents/`、`components/chat/` 及两套 chat hook。

4. **前端超级组件与横切膨胀**：
   - 超级组件：`MatterDetail.tsx`（3,114 行 / 32 `useState`）、`CustomAgentDrawer.tsx`（1,405 行 / 50 `useState`）、`McpServiceTab.tsx`（1,915 行 / 34 `useState`）、`ComposePanel.tsx`（1,680 行 / 28 `useState`）、`CommandPalette.tsx`（2,030 行）、`onboarding/steps.tsx`（2,576 行）。
   - 横切单体：`electron/renderer/index.css`（6,402 行）、`zh-CN`/`en-US/common.json`（各 8,896 行，90 天改 74 次）；`icons/animated/` 含 462 个具名导出图标（Rollup 自动摇树，保留全量便于新功能离线取用）。

5. **跨语言手抄契约税**：
   - 50+ 跨语言 parity 静态测试 + `cli.gen.ts`（3,171 行）+ 手写 `shared/api/types/*.ts`（6k+ 行），新增枚举/字段常需改 4–5 处。

---

## 3. 六大模块 + 资料库诊断矩阵

| 模块 | 全栈体量 (PY / Node&IPC / UI) | 现状评估 | 核心收敛靶点 |
|---|---:|---|---|
| **AI Chat & Agents** | **174.1k** (61.7k / 44.3k / 68.1k) | 🔴 最重 | 三进程边界、`ai_chat.db` 单一所有权、四大 2k+ 单文件拆分、`CustomAgentDrawer` / `BlockRenderer` 收敛 |
| **邮件 Email** | **74.8k** (52.3k / 3.5k / 19.0k) | 🟠 包袱重 | `sync_store.py` 拆解、`email_repository.py` 拆存储与检索、`new_watcher.py` hook 解耦、读路径先测再切、`ComposePanel`/`EmailDetail` |
| **事项 Matters** | **39.2k** (15.9k / **0** / 23.3k) | 🟡 内胖外净 | **传输层全站样板（0 IPC 纯 HTTP）**；集中拆分 `matters/service.py`（6.4k）与 `MatterDetail.tsx`（3.1k） |
| **设置 & Onboarding** | **35.4k** (2.8k / 5.0k / 27.6k) | 🟡 表单重 | `McpServiceTab` / `FolderPicker` / `onboarding` 拆分、清退役残余（如 `IslandUpdatesTab` 改名）、清理历史灰度开关、i18n 分域 |
| **日历 Calendar** | **18.9k** (9.2k / 1.3k / 8.4k) | 🟢 UI 佳 / 桥老 | **前端拆分全站最健康**（最大文件 837 行）；切掉 Electron `calendar-*` CLI 子进程，审视 `calendar_notion` 与 `calendar_sync` 重叠 |
| **通讯录 Contacts** | **13.1k** (5.3k / 0.4k / 7.4k) | 🟢 最轻 | `routers/contacts.py` 40 处裸 SQL 下沉 repository；迁移仅剩 1 个 IPC（`email:contactSuggest`）；拆分 `ContactDetail.tsx` |
| **资料库 Library** | **12.2k** (5.7k / 0.2k / 6.3k) | 🟢 较新 | 结构清晰，暂不列入优先拆解对象 |

---

## 4. 四波次演进路线图与验收门禁

### Wave 0：公共地基物理拆解 + 纯减法（横切 · 零业务语义变更）
- **范围**：
  1. 审计 `icons/animated/`（462 个文件）：因采用纯具名导出且 Rollup 自动摇树，保留全量 462 个 vendor 动画图标（生产包零开销，便于新功能即查即用）。
  2. 物理拆解 `src/mail/sync_store.py` → `sync_store_schema.py`（DDL / 类型 / 迁移辅助）+ `sync_store_migrations.py`（v3–v75 历史迁移）+ `sync_store.py`（保留 `DB_VERSION`、`_INITIALIZED_DBS`、re-export 兼容层与邮件 CRUD）。
  3. 物理拆解 `frontend/src/electron/renderer/index.css` → `index.css` 入口 + `styles/*.css`（按域 8 个子样式，100% 保持原级联顺序、`@layer base` 与 `data-glass`/`data-surface` 等活跃规则）+ `readRendererCss.ts` 文本闸辅助。
  4. 清理退役命名残余：`IslandUpdatesTab.tsx` → `UpdatesTab.tsx`。
- **门禁**：Python `agent_eval` / `config` / `mail` / `matters` / `calendar_sync` 测试全绿；`pnpm --dir frontend typecheck && pnpm --dir frontend lint` 0 errors；受影响 vitest 闸 + Tailwind CLI 编译 + `build:web` 全绿。

### Wave 1：传输层向 Matters 看齐（消除 CLI 子进程与双跳）— ✅ 已完成
- **原则**：业务读写走本机 `serve-api` loopback HTTP；Electron IPC 仅保留原生 OS 能力（Keychain、窗口/托盘、系统权限、原生文件框、`WebContentsView`、自动更新、子进程管理）。
- **步骤与落地结论**：
  1. **日历 / 报告 / Admin / 通讯录 / 邮件写 / Compose / Prompts 去 CLI 与去双跳（1A + 1B）**：消除 `calendar-{read,write,sync}`、`report`、`admin` 的 `callCli` 子进程、`handlers/contacts.ts` 残留 IPC、`write_ops`、`prompts` 与 `draft.ts` 6 个 compose 转发通道；统一经 `ElectronApi.loopbackHttp`（`HttpApi(..., { retryNetworkOnce: true })`）直连本机 `serve-api`，同步修复 `CORSMiddleware` 与 `chat_local_bridge` 的 `PUT` preflight。仅保留 `email:createDraft` 的 AppleScript 回退、`admin:exportDiagnostics`/`dbPath` 与 3 个 legacy calendar Notion-mirror IPC。
  2. **邮件读路径 6 万封 Benchmark 实测决策**：
     - 真实 1.8 GB 库（9,311 行）：`listEnriched p1` Direct-SQL P95 `17.55ms` vs Loopback-HTTP P95 `26.71ms`；`get(id)` `0.02ms` vs `1.77ms`；`body(preview)` `0.01ms` vs `1.71ms`；`listMailboxes` `3.04ms` vs `5.07ms`。
     - 合成 60,000 封大库：`listEnriched p1` Direct-SQL P95 `8.50ms` vs Loopback-HTTP P95 `12.22ms`；`listEnriched deep (offset=20k)` `52.66ms` vs `61.80ms`；`listByThreads (50)` `0.09ms` vs `2.76ms`；`listMailboxes` `20.75ms` vs `24.64ms`；`get`/`body` `0.02ms` vs `1.73ms`。
     - **决策**：保留 `handlers/email.ts` + `handlers/attachment.ts` 作为受控只读 SQLite fast-path（高频单行/线程 P95 低 1–2 个数量级，且保住 `serve-api` 重启窗口桌面只读可用性）。
  3. **OpenAPI → TS 契约减税评估**：
     - 实测 FastAPI `app.openapi()`：`393 paths / 464 operations`，请求体仅 `92/201` 有 Pydantic schema（`109` 处 `dict[str, Any]`），**`200` 响应 `0/464` 带声明型 schema**（统一经 `success_envelope()` 返回裸 `JSONResponse`），`components.schemas = 91`。
     - **决策**：现阶段全量运行 `openapi-typescript` 收益为负（只会生成 `unknown`/缺省响应）。延后至 Wave 2 按域重构时逐步引入泛型 `Envelope[T]` + `response_model`（从 `matters` / `contacts` 起步）后再试点 codegen。

### Wave 2：业务模块逐个垂直瘦身
按「见效快 → 核心域」顺序逐个房间清理：
1. **事项 Matters（试点）— ✅ 已完成（Wave 2.1）**：
   - 后端 `src/matters/service.py`（6,415 → **1,470** 行）拆分为零循环叶子 `service_common.py`（70 行）+ 7 个领域 Mixin 子模块（`service_dispatch.py` 948 / `service_items.py` 352 / `service_progress.py` 338 / `service_resources.py` 1,388 / `service_stakeholders.py` 594 / `service_tags.py` 314 / `service_updates.py` 1,155）+ `MatterService` 薄门面（保持 `MatterRunService` 继承、全量常量 re-export 与 `_transaction` 单一出口闸覆盖全部 `service*.py`）。
   - 前端 `MatterDetail.tsx`（3,114 → **1,164** 行）拆入 `detail/` 5 个高内聚子模块：`MatterDetailControls.tsx`（887 行）、`MatterGoalCard.tsx`（298 行）、`MatterItemGroups.tsx`（457 行）、`MatterStateCard.tsx`（184 行）、`useMatterDetailMutations.ts`（339 行），全部通过 `matterMutationGate` / `matterRefreshGate` / `matterTimelineModel` 结构闸与 ESLint / TS / Vite 构建门禁。
2. **通讯录 & 日历 — ✅ 已完成（Wave 2.2）**：
   - 通讯录后端：`src/api/routers/contacts.py`（1,321 → **889** 行）全量裸 SQL 清零（`execute(` = **0**），9 个读侧查询与投影统一下沉 `src/contacts/repository.py`（37 → **587** 行）；`src/skills/builtin/contacts.py` 直接依赖 `contacts.repository` / `contacts.service`，不再经 FastAPI 路由模块中转。
   - OpenAPI 试点：在 `src/api/schemas/envelope.py` 定义泛型 `SuccessEnvelope[T]`（导出于 `src/api/schemas/__init__.py`），在 `src/api/schemas/contacts.py` 补齐 37 个响应与 DTO 模型，`routers/contacts.py` + `routers/contact_agent.py` 全部 **27** 个 `/api/contacts*` 端点挂载 `response_model=SuccessEnvelope[...]`，实测 OpenAPI schema 与实时响应模型校验全绿。
   - 日历审计：确认 `src/api/routers/calendar.py` 已有 **0** 处裸 SQL、Calendar 前端模块拆分健康，且 `src/calendar_notion/` 已严格受控于 `calendar_notion_enabled()` 并复用 `src/calendar_sync/_common.py`，不强行合并以免扩大同步回归面。
   - 通讯录前端：`ContactDetail.tsx`（1,097 → **634** 行）拆出 `detail/ContactFieldRows.tsx`（290 行）与 `detail/ContactActivityLists.tsx`（181 行），通用日期辅助 `fmtContactMonth` 迁入 `contactFields.ts`（24 行）。
3. **邮件 Email — ✅ 已完成（Wave 2.3A 后端 + Wave 2.3B 前端）**：
   - **后端（Wave 2.3A ✅）**：`src/repository/email_repository.py`（5,212 → **1,140** 行）拆分为 6 个无环子模块：`email_models.py`（623 行）、`email_contacts.py`（414 行）、`email_attachment_text.py`（682 行）、`email_search_trigram.py`（892 行）、`email_search_predicates.py`（603 行）、`email_search_fts.py`（989 行），保留全部 re-export 与可变缓存引用；`src/mail/new_watcher.py`（3,059 → **1,349** 行）拆出 `new_watcher_hooks.py`（893 行）与 `new_watcher_reconcile.py`（861 行），保持全部权威常量与测试 `monkeypatch` 兼容。`ruff` 0 错，**2,590** 项后端回归全绿。
   - **前端（Wave 2.3B ✅）**：`ComposePanel.tsx`（1,680 → **747** 行）拆出 `useComposeAttachments.ts`（393 行）、`useComposeMutations.ts`（274 行）、`useComposeTabSnapshot.ts`（242 行）与 `ComposeHeaderFields.tsx`（432 行）；`EmailDetail.tsx`（1,676 → **426** 行）拆出 `detail/useEmailDetailTranslation.ts`（193 行）、`detail/useEmailDetailActions.ts`（261 行）、`detail/useEmailTabSync.ts`（260 行）与 `detail/EmailDetailHeader.tsx`（478 行，保留 `NavPersonChip` 延迟挂载 `useNavigate` 边界）。21 个 Vitest 文件 / **335** 项测试全绿，改动文件 `eslint --no-cache` 0 错 0 警告，全量 `typecheck` / `lint` / `build:web` / `electron-vite build` 全过。
4. **设置 & Onboarding（2.4A UI 拆解 ✅ · 下一步：2.4B i18n 与开关审计）**：
   - **UI 拆解（Wave 2.4A ✅）**：`McpServiceTab.tsx`（1,915 → **175** 行）拆出 `mcp-service/` 6 个子模块（`mcpServiceUtils.ts` 183 / `McpConnectionSection.tsx` 315 / `McpKeyScopesDialog.tsx` 496 / `McpKeyModals.tsx` 361 / `McpKeysSection.tsx` 268 / `McpToolsAndAudit.tsx` 238）；`FolderPicker.tsx`（1,398 → **431** 行）拆出 `FolderTreeRows.tsx`（450）、`FolderSyncedOrderSection.tsx`（327）与 `useFolderManage.ts`（279）；`onboarding/steps.tsx`（2,576 → **33** 行兼容门面）拆出 `wizard/` 8 个子模块（`types.ts` 77 / `StepWelcomeAndFda.tsx` 314 / `StepBackend.tsx` 234 / `StepConfigParts.tsx` 364 / `StepConfig.tsx` 532 / `StepFolders.tsx` 332 / `StepSyncAndPlugins.tsx` 357 / `StepAiAndDone.tsx` 409）。15 个 Vitest 文件 / **145** 项测试全绿，改动文件 `eslint --no-cache` 0 错，全量 `typecheck` / `lint` / `build:web` / `electron-vite build` 全过。
   - **i18n & 开关审计（下一步：Wave 2.4B）**：审视清理已完成 cutover 的历史灰度配置开关，并按业务域拆分 `common.json` i18n namespace。

### Wave 3：AI Chat & Agents 专项重构
独立立项治理全仓最大体量域：
1. 拆解 `ai_gateway_lifecycle.ts`（剥离进程管理与群聊/落库胶水）。
2. 拆分 `ai-gateway/server.ts` 路由、`domainClient.ts` 分域客户端、`tools/schemas.ts` 下沉至各 `tools/*.ts`，抽取 `chatRun` / `agentRun` / `groupOrchestrator` 公共流控底座。
3. 结束 `ai_chat.db` Python + Node 双写，收敛单一写权所有者。
4. 合并前端 `shared/assistant` / `components/agents` / `components/chat` 重复容器与 hook，拆解 `CustomAgentDrawer.tsx`（50 `useState`）和 `BlockRenderer.tsx`。

---

## 5. 明确「不做项」（边界护栏）

- **不做 Python → Node 技术栈大一统**：成本极高且 v4.0 刚发布，保持 Python 领域后端 + Node AI SDK Gateway 的双进程分工，只理顺协议边界。
- **不为架构洁癖牺牲大邮箱性能**：大邮箱邮件列表/全文搜索若 loopback HTTP 实测不优于 IPC 直读，允许保留受控只读 fast-path。
- **不做「每个文件 < 300 行」机械一刀切**：优先治理「体积 > 1,500 行 ∧ 近 90 天高修改频次」的交集热点，稳定低频模块保持克制。

---

## 6. 阶段状态看板

| Wave | 主题 | 状态 | 核心指标前后对比（实测） |
|---|---|---|---|
| **Wave 0** | 公共地基物理拆解 + 命名清理 | ✅ 已完成 | 保留全量 462 个 `icons/animated/`（纯具名导出、生产包 0 KB 开销，便于新功能即查即用）；`sync_store.py`: 8,327 → **3,467** + `sync_store_schema.py` (1,403) + `sync_store_migrations.py` (3,589)；`index.css`: 6,402 → **12 行入口** + `styles/*.css` 8 个按域子文件 (6,398 LOC)；`IslandUpdatesTab.tsx` → `UpdatesTab.tsx` |
| **Wave 1** | 传输层收口（去 CLI 子进程 / 去双跳） | ✅ 已完成 | **1A+1B 累计**：12 个旧 handler + 11 个旧测试删除；`handlers/` IPC 通道 **137→69**（移除 69 条，新增 1 条 `admin:dbPath`，净 **-68** / -49.6%）；`callCli` 20→**5**（-15）；`ElectronApi.ts` 1,082→**648** 行；`draft.ts` 574→**372** 行；`daemon_api.ts` 113→**85** 行；前后端 CORS `PUT` 与日历 `tzid` 全链对齐；代码与测试净减 **-6,040 LOC**（+844 / -6,884）；6 万封读 benchmark 保留只读 SQLite fast-path，OpenAPI→TS 延至 Wave 2 `response_model` 就绪后试点 |
| **Wave 2** | 业务模块垂直瘦身（Matters → Contacts/Cal → Email → Settings） | 🚧 进行中（2.1 Matters ✅ · 2.2 Contacts/Cal ✅ · 2.3 Email ✅ · 2.4A Settings/Onboarding ✅；下一步：2.4B i18n/开关审计） | **2.1 Matters**：`service.py` 6,415→**1,470** 行 + 8 子模块；`MatterDetail.tsx` 3,114→**1,164** 行 + 5 `detail/*`。<br>**2.2 Contacts/Cal**：`routers/contacts.py` 1,321→**889** 行（裸 SQL **0**）+ `contacts/repository.py` 37→**587** 行；**27** 个 `/api/contacts*` 端点挂载 `SuccessEnvelope[T]`；`calendar` 0 裸 SQL 维持隔离；`ContactDetail.tsx` 1,097→**634** 行 + 2 `detail/*`。<br>**2.3 Email**：`email_repository.py` 5,212→**1,140** 行 + 6 子模块、`new_watcher.py` 3,059→**1,349** 行 + 2 子模块（**2,590** 项后端测试 + `ruff` 全绿）；`ComposePanel.tsx` 1,680→**747** 行 + 4 子模块、`EmailDetail.tsx` 1,676→**426** 行 + 4 `detail/*`（21 文件/**335** 项 Vitest + `typecheck` + `lint` + 双端构建全绿）。<br>**2.4A Settings/Onboarding**：`McpServiceTab.tsx` 1,915→**175** 行 + 6 `mcp-service/*`；`FolderPicker.tsx` 1,398→**431** 行 + 3 子模块；`onboarding/steps.tsx` 2,576→**33** 行（+ 8 `wizard/*`，15 文件/**145** 项 Vitest + `typecheck` + `lint` + 双端构建全绿） |
| **Wave 3** | AI Chat & Agents 专项收敛 | ⏳ 待启动 | 目标：解耦 `ai_gateway_lifecycle` / `ai-gateway` / `ai_chat.db` 双写 |
