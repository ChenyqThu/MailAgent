# MailAgent 架构整体 Review（2026-07）+ 优化路线图

> **日期**：2026-07-02 · **方法**：6 个只读审查 agent 并行深查（同步内核 / 服务层 / AI 栈 / 前端 / 打包运维 / 横切质量），其中 5 份回传；横切质量 lane 未回传，其独有盲区由主会话自查补齐（CI 测试面、依赖锁定、docs 治理、密钥引用面均已实测）。**文中引用的 file:line 证据均经主会话二次核实**（核实中发现的口径修正已反映在正文）。工作区经 `git status` 复核，审查过程零误改。
> **配套实施方案**：[E0 安全网](./e0-safety-net.md) · [E1 Backend 契约](./e1-backend-contract.md) · [E2 减法 Sprint](./e2-subtraction-sprint.md) · [E3 配置治理](./e3-config-governance.md) · [E4 可靠性/观测](./e4-reliability-observability.md)

## 0. EWS 口径（先说清，防误读）

**EWS 2026-10-01 关停不需要本项目做任何应对工程**：届时跟随 davmail 官方 repo 切换 O365 标准接口即可，与本项目无关的事项（应用注册、审批流程等）不在任何规划中。项目侧仅保留一个 watch 项：**2026-08 起关注 davmail release，出新版及时升级并按回归清单验证 davmail 仍可用**（见 [E1 §3.1 Step 4](./e1-backend-contract.md)）。AppleScript fallback 在过渡期内继续保留作 last-resort。

## 1. 总体判断

**架构方向是对的，工程底子是好的；当前最大的问题不是"设计错了"，而是"演进做了一半"。** 自 2026-01-22 首 commit 起五个多月、1279 个 commit 的高速演进中，每一轮大迁移（dual-backend、outbox 反转、chat 引擎 cutover、服务层统一）都完成了 70-80% 就被下一个 epic 接管，留下一批「新旧并存、默认值与生产相反、抽象被影子层适配」的半程状态；叠加两个系统性缺口（**CI 无测试闸、用户数据无备份安全网**）。**下一阶段的主题应该是一场"收敛减法" + 补安全网，而不是新架构。**

### 规模速览（2026-07-02）

| 维度 | 数据 |
|---|---|
| Python 后端 | `src/` 84.4k LOC / 243 文件（top：mail 14.9k · cli 10.5k · api 10.3k） |
| Python 测试 | `tests/` 57.9k LOC（另 frontend 181 个测试文件） |
| 前端 TS | 102.4k LOC（shared 76.4k · electron 19.7k · ai-gateway 5.9k · web 0.4k） |
| 其他 | webhook-server 1.0k · site 4.1k |
| 数据层 | SQLite DB_VERSION=29（Python/TS 两侧一致，有兜底测试） |
| 发布 | v1.2.0（GitHub Releases + Developer ID 签名 + 公证 + 自动更新） |

## 2. 护城河（保持项，各 lane 一致确认）

- **outbox 原子 UPSERT**（`src/sync/outbox.py:158`）：单条 SQL `ON CONFLICT DO UPDATE json_patch` 消除读改写竞态；outbox 与 sync_store 两套重试/死信退避策略一致（`[60,300,900,3600,7200]`×5 + 飞书告警）。
- **外发安全纵深**：`send_guard` HMAC approval token + `send_ledger` 原子幂等 + 跨语言 content hash 双 guard（`src/services/send_guard.py:117/188`）——不可逆路径防线全项目最扎实。
- **鉴权 fail-closed 纪律**：scoped key 故意只挂 `/api/skills` 防越权发信（`src/api/agent_auth.py:17-20`）；无鉴权方式即拒绝启动（`src/api/auth.py:88`）。
- **进程生命周期工程**（`frontend/src/electron/main/backend_lifecycle.ts`）：pipe 背压防御、孤儿进程三层防御、crash-loop 断路器、DB 门控 `>=` 容错——踩过的坑固化进了代码。
- **前端边界干净**：`MailApi` 抽象让 76k 行 `shared/` 真正双宿主（IPC/HTTP）复用，`shared/` 内仅 3 处 `window.electron` 全在边界文件；subscribe disposer 已 pattern 化（`shared/api/ElectronApi.ts:178-206`）；列表性能铁律真落地（react-window + 84 处查询缓存参数）。
- **agent_eval 零-LLM 硬闸设计**（R1-R8 以写工具为中心建模 HITL、typed evidence grounding）方向正确——欠的只是进 CI（见 P0-1）。
- **文档/归档治理在执行**：docs/ 顶层无违规堆积（实测），常青/过程两轴分流在运转。

## 3. 核心发现（按优先级，已合并去重）

### P0 —— 两个系统性缺口（都不是重构，是补窟窿）

**P0-1 CI 没有任何测试闸。** `.github/workflows/` 仅 `build-mac.yml`，全文 pytest/vitest/agent_eval 零命中（实测 grep=0）——tag 到签名发布只有 typecheck 一道机器闸；「改引擎必跑 agent_eval」「DB_VERSION 两侧一致」等纪律全靠人肉。对一个会真实发邮件的 agent 产品，改 prompt/工具的行为回归也无 pre-release 门。→ **[E0 WP1](./e0-safety-net.md)**

**P0-2 用户数据没有安全网。** `sync_store.db` / `agent_config.db` / `ai_chat.db` 无自动备份、无启动完整性检查；且迁移代码吞错——v27/v29 的 ALTER 真失败被 `except OperationalError → warning` 吞掉后，`db_version` 仍无条件写 29（`src/mail/sync_store.py:1504-1553`），列缺失但版本号前进、永不重试；也无降级守卫。App 已分发非开发者用户，DB 坏 = 无回退。→ **[E0 WP2/WP3](./e0-safety-net.md)**

### P1 —— 收敛主线（"半程迁移"群）

**P1-1 IMailBackend 抽象未成为契约，被 arm-compat 影子层适配 + 外围入口硬绕过。** `DavMailBackend` 以 `self.arm = self / self.radar = self` 伪装成 AppleScriptArm（`davmail_backend.py:311-312`），全系统事实契约是「AppleScriptArm 形状」；async-jobs 批量执行器 `backfill_body` 无条件直构 `AppleScriptArm(...)`（`src/sync/job_runners.py:261`，davmail-space id 打到 Mail.app 必失配），另有 reverse_sync 默认值、LLM runner fallback、init、外挂模块等 ~7 处 factory 外直构（全量对账见 [E1 §2.2](./e1-backend-contract.md)）。→ **[E1](./e1-backend-contract.md)**

**P1-2 双 chat 引擎并存，且新引擎反向依赖旧引擎。** legacy `shared/chat/` 9.4k LOC 未删；`ai-gateway/systemPrompt.ts:19` import legacy 的 `buildStableSystemPrompt`（**任务B 不是 rm -rf，前置是抽 prompt 中立层**）；新 UI 层仍以 `useEmailChat` 为传输 SSoT（`AssistantUIChatPanel.tsx:214`）；工具 schema 双实现靠人肉镜像；legacy 回退路径注入防线弱于新引擎（`custom_api.ts:355` 邮件正文无围栏）——删除本身是安全修复。→ **[E2 子包 A](./e2-subtraction-sprint.md)**

**P1-3 outbox 灰度死分支 + 默认值与生产相反。** `mailagent_outbox_enabled` 默认 False（`config.py:530`）而生产恒 on（`reverse_sync.py:22` 自注「生产 outbox=on 不可达」）——每个 mutating handler 背着生产不可达的老分支；B1 退役决策文档已备好未执行。→ **[E2 子包 B](./e2-subtraction-sprint.md)**

**P1-4 写路径两套半。** 正向用户写已真收敛 `MailWriteService`（亮点），但反向写在 `events/handlers.py:216` 另有一份 flag→outbox 实现；4 处 fork CLI 残留（admin dead-letter retry/cleanup、email legacy update-flag、llm selftest——各文件头注释自认）。→ **[E2 子包 C/D](./e2-subtraction-sprint.md)**

**P1-5 配置载体四分裂 + 手抄一致性靠人肉。** pydantic ~140 Field（validation_alias 14）/ env-only 直读 / Node envBool / vite define 两份手抄镜像；同一 epic 的 flag 拆两语言读取（MEM0_CAPTURE→Node、RETRIEVAL→Python）；CLAUDE.md 开关表已有漂移实例（`config.py:459 agent_harness_enabled=True` vs 表中 false）。这是历史事故类别（Field(env=) 失效、vite define 漏加、EXPECTED_DB_VERSION 漏改）的共同根因。→ **[E3](./e3-config-governance.md)**

**P1-6 两个单体进程缺 worker 级隔离 + 循环内阻塞 IO。** serve 单 loop 挤 ~15 worker（`service.py:402-588`），worker 静默死不触发进程重启；主循环同步阻塞 fetch（`new_watcher.py:696`）一封慢邮件卡整个 loop；serve-api 16 router+SPA+gateway 代理单进程（`app.py:427-449`，chat.py 单文件 30 端点）。→ **[E4 §1/§2](./e4-reliability-observability.md)**

**P1-7 Python 依赖零锁定。** `requirements.txt` 53 行全 `>=` 无一 `==`（实测）——嵌入式 venv 每次 provision 可能拉到不同版本，打包再现性弱（文件内 caldav/vobject 注释записан的「传递依赖漂移断链」正是此根因）。→ **[E0 WP5](./e0-safety-net.md)**

### P2 —— 加固项（择要）

- **SSE 跨进程盲区**：serve-api 进程内的写事件到不了 serve 进程的 SSE 订阅端（`inprocess_bus.py` 模块注释自述 lossy 边界）——#36 类 live-refresh 症状的结构性背景。→ E4 §6.4（先记录，症状驱动选型）
- **release 转正式仍是纯手动步骤**（漏做 → latest/auto-update 停旧版）。→ E0 WP4
- **告警五项欠账**（davmail watchdog / token 老化 / outbox 积压等，roadmap §4.2 至今 ❌）+ crash 日志每次 spawn 截断（`backend_lifecycle.ts:593 flags:'w'`）、非开发者无诊断通道。→ E4 §3/§4
- **前端两处巨石 + IPC 无 typed 契约**：types.ts 2415 行 / chat_db.ts 1599 行（实测）；118 channel 字符串约定、preload 18 行泛型透传。→ E4 §6
- **webhook-server 双套契约**：与本地 src/ 零共享（py3.9 独立实现），Notion webhook 改一端易漏另一端。→ 登记，暂不动（改动频率低）
- **venv 425MB 中 ~100MB 是 mem0/onnx/faiss 恒随包**。→ E4 §5（审计先行，按需下载挂起）
- **Mail.app 端手动改 flag 目前不反向同步**（`new_watcher.py:1449` short-circuit 悬挂，Sprint 15 有意保留）——功能缺口登记，等真实需求再激活。
- **文档漂移实例**：`ai-sdk-gateway-architecture.md` 头部仍 `status: planning`；CLAUDE.md 开关表 `MAILAGENT_AGENT_HARNESS` 默认值与代码不符。→ 随 E3 Step 1 对账修复。

## 4. 路线图

主线：**先立安全网 → 再做减法 → 契约收口**。减法要有 CI 网兜着才敢删；handlers 的死分支删除落在 E1 收口后的干净接口上。

| 阶段 | Epic | 一句话 | 量级 | 文档 |
|---|---|---|---|---|
| **Now（≤2 周）** | E0 安全网 **✅ 已实施 + CI 首跑全绿**（2026-07-02/03，实施状态见 e0 §5） | CI 测试闸 + DB 备份/quick_check + 迁移守卫 + promote workflow + 依赖锁定 | ~1 周 | [e0](./e0-safety-net.md) |
| **Next（1-2 月）** | E1 Backend 契约收口 **✅ 已实施**（2026-07-03，实施状态见 e1 §6：Protocol=17 方法真实面、影子 alias 退役、外围收编即修复 id-space 错配） | arm 面正式化为 Protocol、删影子 alias、外围入口收编 factory；davmail 上游 watch 提醒项 | 3-5 天 | [e1](./e1-backend-contract.md) |
| **Next（1-2 月）** | E2 减法 Sprint **✅ B/C/D 已实施**（2026-07-03，实施状态见 e2 §8：outbox 恒启用+死分支删除、fork CLI 退役、反向写归一 `outbox_intents.py`，净 -1150 行；**子包 A 已移交 openness epic S3**，见 e2 §2） | 删 legacy harness + outbox 收口删死分支 + fork CLI 退役 + 反向写归一 | ~2 周（B/C/D） | [e2](./e2-subtraction-sprint.md) |
| **Next（可并行）** | E3 配置治理 | 四项一致性校验测试进 CI → env-only 收编 → 偏离决策表 | ~1 周 | [e3](./e3-config-governance.md) |
| **Later（3-6 月）** | E4 可靠性/观测 | worker supervise / to_thread / 告警落地 / 诊断包 / venv 审计 / typed IPC / 巨石拆分 | 按条目 | [e4](./e4-reliability-observability.md) |
| **持续 watch** | davmail 上游 | 2026-08 起关注 davmail release（EWS→O365 标准接口），出新版按 [升级回归清单](./e1-backend-contract.md) 验证 | — | e1 §3.1 Step 4 |

**明确不做**（避免过度设计）：微服务化拆分（单机单用户，进程内隔离足够）；换数据库（SQLite+WAL 完全胜任）；提前启动 Python→TS 大迁移（`docs/reference/packaging/04-tech-stack-unification.md` 维持 park，其「venv 体积全有或全无」铁律仍成立）；重写/下架 AppleScript fallback（EWS 过渡期内保留）；任何 Graph API / 应用注册相关工作（见 §0）。

## 5. 一句话总结

这套系统的骨架（SQLite SSoT + outbox fanout + 双宿主前端 + 统一写面）经受住了五个月高速演进的考验，值得信任；现在最划算的投资不是加新东西，而是**把四场未完成的迁移收口、给发布和数据加上安全网**——davmail/EWS 只需跟随上游，不构成本项目的工程负担。
