# 灵动岛（Ping Island）对接移除 —— 评估与执行计划

> **状态：暂缓执行**（owner 2026-08-21 拍板：评估落档，删除动作另行排期）。
> 届时随删的两项预拍板（同日）：① DailyDigest 每日巡检**随岛一并删**（不换投递面；日后需要可在通知中心重建）；
> ② LLM 输出字段 `recommended_actions`（岛按钮推荐）**一并砍**（岛没了无消费者，每封邮件白耗 token）。
> 前置补位：通知中心 M2 已排 macOS 原生通知 fanout（见 §5 行为缺口——那是岛的核心价值替代）。
> 评估基准 commit：`04bbb674`（2026-08-21）。执行前若隔了较久，先复核 §2 清单的行号漂移。

## 1. 改动面判定：大（但核心风险已被历史拍板消掉）

跨 2 个进程语言（Python serve-api / TS Electron+ai-gateway）+ 1 个 DB 表 + 1 个 LLM 输出 schema/prompt + 6 个非 notify 模块旁路耦合 + 官网站点；约 90+ 文件、≈12,000 行（岛模块 3,896 + Electron 岛桥 1,001 + 测试 ≈5,600 + 散点）。

三个不是「删文件就完事」的点：
1. ~~`src/reports/data.py:18-20,306` **硬 import** `island_dispatch.py` 的 `URGENT_PRIORITY_LABELS`/`ACTION_NEEDS_FLAG`~~ —— **已解除**（2026-08-31，task 08-27 P4c 顺手做的）：两常量下沉到 `src/llm_agent/schema.py`（action/priority 词表的定义处），`island_dispatch.py` 反过来 import 它们。现在的消费方是 `reports/data.py` · `notify/digest_query.py` · `today/aggregate.py` · `notify/island_dispatch.py`，删岛只需删最后一个。
2. `src/llm_agent/schema.py:67-104,276,320-327` + `processor.py:38,119-146,561-620` + `prompts/email_inbox.md:138` / `email_sent.md:92` —— 「岛按钮推荐」编进了每封邮件的 LLM 结构化输出（已拍板随删；改 schema 后跑 schema-consistency-reviewer；存量 `result_json` 里的旧字段只是被忽略，无读取方风险）。
3. `src/service.py:707-741` —— DailyDigest 启动**嵌套**在 `if self.island_enabled:` 内，无独立路径（已拍板随删）。

**审批链安全（最关键结论）**：`serverResumeEnabled` 已于 2026-07-15 拍板硬编码恒真（`ai_gateway_lifecycle.ts:468`），岛只是审批的第二入口 + `announceApprovalToIsland` 通知腿；端到端测试 `frontend/tests/ai-gateway/approval_island_off.test.ts` 证明岛全关时审批链完好。**通知中心零耦合**：`run_worker.py` 里 `_publish_notification` 与 `_post_announce` 并列独立。**飞书链零耦合**（`events/handlers.py:287` 是独立字面量，无 import）。

## 2. 完整移除清单

### 2.1 Python notify 岛模块（整文件删，共 3,896 行）

`src/notify/` 下：`island_dispatch.py`(1165，~~先搬 :58-59 两常量~~ 已于 2026-08-31 搬进 `llm_agent/schema.py`，整文件可直接删) · `island_response.py`(548) · `island_agent.py`(304) · `island_reconnect.py`(339) · `island_snooze.py`(228) · `island_envelope.py`(292) · `island_ack.py`(214，连带其自建懒表) · `island_action_whitelist.py`(104) · `island_bootstrap.py`(136) · `island_i18n.py`(116) · `ping_island.py`(162)；另 `src/api/routers/island.py`(288) + `src/api/app.py:420,483` 两行。

### 2.2 DailyDigest（已拍板随删）

`src/notify/daily_digest.py`(351) · `digest_query.py`(261) + 测试 `test_daily_digest_loop.py`/`test_dispatch_daily_digest.py`/`test_digest_query.py`(共 944 行) + `MAILAGENT_DAILY_DIGEST_*` flag。

### 2.3 数据库

- `island_dispatch` 表（v7 迁移史内）：**留 tombstone 不发 DROP 迁移**，停写即冻结；读写方法 `sync_store.py:7705-7830` 删除；`src/services/admin_health.py:52` 必查表清单去掉该行；迁移测试 `test_sync_store_v6_migration.py:71,96,114,138`、`tests/cli/test_admin.py:65` 改断言。
- `island_ack_pending`（`island_ack.py:67` 自建懒表，不进 DB_VERSION）：随文件删除自然消失。

### 2.4 Python 旁路耦合（删段/改行）

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/service.py` | :339-373 / :707-741 / :949-952 / :1210-1221 | island 初始化链 + 3 后台任务 + dead-letter 岛卡 hook（≈70 行） |
| `src/mail/new_watcher.py` | :1840,:1869-1870,:2191-2192 + `_maybe_dispatch_island_received/reviewed` (:2410-2475) | 邮件到达/LLM 判定派发 hook（≈70 行） |
| `src/agents/run_worker.py` | :516 调用 + :666-675 方法体 | `_post_announce` agent run 终态岛推送（M3 盘点补录：批 1 删 `src/api/routers/island.py` 后它会对不存在的路由每次终态发一次 404 loopback + warning，必须随批 1 同删；通知中心 `_publish_notification` 与它并列独立，不受影响） |
| `src/events/handlers.py` | :493-505 | MailCompleted 岛派发 |
| `src/calendar_sync/reminder.py` | :8-13,:82-110 | 会前提醒岛派发（其余日历逻辑不动） |
| `src/config.py` | :890-950 等 | 13 个 island/digest Field（≈60 行） |
| `.env.example` | :231,:475,:735-820 | 岛注释块（≈85 行） |
| `src/api/routers/settings.py` | :121,:222-229 | env key 白名单岛段 |
| `src/llm_agent/` + `prompts/` | 见 §1 点 2 | recommended_actions 链（已拍板砍） |

### 2.5 Electron 主进程（整删 1,001 行）

`frontend/src/electron/main/island/`（envelope/probe/sender/index）+ `handlers/island.ts` + `main/index.ts:55,78,462` 调用点。注：`aiDraftStart/Stream/Ready/appearance` 四个 IPC 在 renderer 已零调用（死代码）。

### 2.6 ai-gateway（只删 <60 行，文件本体全保留）

`ai_gateway_lifecycle.ts` 的 `announceApprovalToIsland`(:787-817) 与接线(:451,:1289,:1297)；`config.ts` 的 `IslandApprovalAnnounce` 接口与两个可选字段；`chatRun.ts:780-796` announce 块（:944/:989 的 `|| cfg.islandAgentEnabled` 可顺带简化）。`approval.ts`/`approvalResume.ts`/`approvalStash.ts`/`agentRun.ts`/`server.ts` **只改注释不动代码**。

### 2.7 前端 UI

整删：`shared/state/island.ts` · `shared/api/types/island.ts`。改：`ElectronApi.ts`(:97-102,:749-775,:983) · `HttpApi.ts`(:860-871) · `types.ts`(:202-209) · **`IslandUpdatesTab.tsx` 只删 Island/Digest 子块，`UpdaterSubsection`(:296-516 自动更新) 必须保留**并更名 · `SettingsRail.tsx:56` · `SettingsShell.tsx:38,176-177` · `router-instance.tsx:387` · `StatusBar.tsx`(≈15 行) · `keymap.ts:243-251`(toggleIsland 从未实现) · i18n 两份 locale 的 `settings.island.*`/`titleBar.island.*` 键 · onboarding 三处（`steps.tsx:2018-2038,2407` / `handlers/onboarding.ts:218-224` / `onboarding/ipc.ts:111`）· `env-keys.ts:107,125,129,274-286`。

### 2.8 🔴 命名陷阱——叫 island 但**不能删**

- `AiChatPanel.tsx` 的 `islandRefreshNonce` 系列 + `ThreadRunningBridge.tsx` + `threadRunningGuard.ts` + `queryKeys.ts:179-182`：服务的是 `onServerResumeSettled` **无条件**广播（含面板内审批卡刷新）——**只能重命名，删了破坏 chat 审批主路径**。
- `PendingApprovalPanel.tsx`：主审批 UI 本体，与岛无关。
- `deeplink.ts`：通用 `mailagent://` scheme 基础设施，保留。
- `site/` 里的 "Astro Islands" 是架构术语，同名不同义，禁止误删。

### 2.9 测试

整删：Python 岛专属 16 文件(4,125 行) + DailyDigest 3 文件 + 前端 3 文件(736 行) + `scripts/dev/test_island_button_wire.py`。改：`test_service_alert_checks.py`(4 处) · `test_flag_cross_language.py`(flag 登记) · 前端 `approval_decide/approval_pending/persist_approval_gate/agent_run` 等测试的 island-on 分支（**island-off 分支保留为回归网**）· e2e 两个 test block。**保留** `approval_island_off.test.ts`（更名为 baseline 测试）。

### 2.10 文档 + 官网

CLAUDE.md :50（文档地图岛行，指向仓外孤儿文件本就待修）+ :120（flag 表行）；`feature-flags-rationale.md:48`；`ai-sdk-gateway-architecture.md` 相关段**保留加 HISTORICAL 标注**（serverResumeEnabled 恒真的决策记录）；`ISLAND-PLUGIN.md`(964 行) 与两份 plans 设计文档移 `docs/archive/`；`site/` 七处（`101/ping-island.md`、`IslandMock.tsx`、PhoneMock fixture、overview/privacy 表行、content.config schema、astro.config 导航——对外可见变更单独走内容审阅批）。

## 3. 执行批次（每批独立 revert）

- **批 0（阻断前置）**：两常量搬中立模块 + `reports/data.py` 改 import。
- **批 1（Python）**：§2.1/2.2/2.3/2.4 全部 + recommended_actions 链 + Python 测试。验收：pytest 全绿分片跑、服务起停无 import 残留、schema-consistency-reviewer。
- **批 2（Electron/UI）**：§2.5/2.7/2.9 前端部分 + `islandRefreshNonce` 系列重命名。验收：typecheck + pnpm test + 设置页无岛 tab。
- **批 3（gateway 腿 + flag）**：§2.6 + `MAILAGENT_ISLAND_AGENT_ENABLED` 双侧删 + flag 跨语言闸更新。验收：agent_eval 回归网不回退。
- **批 4（文档 + 官网）**：§2.10，官网单独提交。

## 4. 残留策略

Flag 全删不留 tombstone（仓内 cutover 先例）；`island_dispatch` 表结构留、停写、可选一次性清数据脚本（不进 migration）；架构决策文档标 HISTORICAL 不删。

## 5. 行为缺口（删岛后用户失去什么）

| 能力 | 通知中心现状 | 结论 |
|---|---|---|
| Agent run 终态提示 | M1 已双写，且比岛卡持久 | 无缺口 |
| 审批等待提醒（App 后台时） | 铃铛是 App 内 UI，后台不可见 | **缺口 → M2 macOS 通知 fanout 补位（已拍板）** |
| 紧急邮件强提醒 | 通知中心未接邮件到达类；飞书平行覆盖紧急一项 | 缺口，靠飞书 + M2 取舍 |
| 会前提醒 | `calendar_sync/reminder.py` 唯一投递面是岛 | 缺口，删除时决定是否转 macOS 通知 |
| DailyDigest | 无替代 | 已拍板接受消失 |
| AI 草稿流式预览 | renderer 零调用，早已名存实亡 | 无实际缺口 |
