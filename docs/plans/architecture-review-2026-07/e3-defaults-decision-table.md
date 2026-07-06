# E3 偏离决策表 — flag 代码默认值逐项归类

> 所属：[架构 Review 2026-07](./README.md) · [E3 配置治理](./e3-config-governance.md) Step 3（WP4）。
> **日期**：2026-07-06 · **性质**：把「代码默认 ≠ 生产实际」的每一项偏离显式归类为「翻默认 / 有意保留 + 理由」，杜绝人肉记忆式的默认值漂移。
>
> **本表是 CLAUDE.md「关键开关现状」表的决策依据源。** CLAUDE.md 那张表的「代码默认」列由 `tests/config/test_claude_switch_table.py`（T4）机器对账 `src/config.py` / `ai_gateway_lifecycle.ts` envBool / `chat.py` `_hot_bool` 三载体实测默认；本表解释「为什么是这个默认」。改任一 flag 默认时，先更新本表的决策 + 理由，再同步 CLAUDE.md 表 + 各载体 —— 否则 T3/T4 会红。
>
> **载体缩写**：pydantic = `src/config.py` Field；Node = `frontend/src/electron/main/ai_gateway_lifecycle.ts` `envBool`；`_hot_bool` = `src/api/routers/chat.py` serve-api 热读 .env（前端 `/chat/config` 投影）。openness 五 flag = Node + `_hot_bool` 双载体；`MAILAGENT_CUSTOM_AGENTS_ENABLED` = Node + pydantic 双载体（`_hot_bool` 投影 fallback 跟随 pydantic）。

---

## 1. 本批翻默认（E3 cutover，2026-07-06）

灰度 flag 生命周期终点：openness epic S1-S6 已随 **v1.4.0**（2026-07-05）发布，dogfood 在真机全 flag-on 状态下通过 R1-R5。默认 false→true，`env` 显式 `false` 保留为应急回退（沿用 M1-M4 随 v1.1.0 cutover 的先例）。**翻默认必须两侧同翻**（Node envBool 默认 + Python `_hot_bool` 字面量 / pydantic Field default），否则 gateway 注册工具但前端投影割裂——`tests/config/test_flag_cross_language.py`（T3）机器守护此不变量。

| flag | 代码默认（本批后） | 生产实际（userData `.env`） | 决策 | 理由 |
|---|---|---|---|---|
| `MAILAGENT_OPENNESS_SESSION_TOOLS` | `true`（Node + `_hot_bool`） | true（dogfood 已显式开） | **翻 true** | 会话检索 3 读工具；返回恒 `UNTRUSTED_CHAT_HISTORY` 围栏。显式 false → `buildGatewayTools` 字节级回退 |
| `MAILAGENT_OPENNESS_CONFIG_TOOLS` | `true`（Node + `_hot_bool`） | true | **翻 true** | 配置读补全 4 工具；`agent_profile_restore` / `agent_memory_update` edit-tier 恒人审不变 |
| `MAILAGENT_OPENNESS_WEB_TOOLS` | `true`（Node + `_hot_bool`） | true | **翻 true** | 联网 2 工具；**外发网络恒人审地板不变**（manual 不进 auto-approve），SSRF 防护不变 |
| `MAILAGENT_OPENNESS_EXEC_TOOLS` | `true`（Node + `_hot_bool`） | true | **翻 true** | 本机执行 3 工具；**安全地板不变**：无结构化白名单命中恒 HITL，class exec = manual_chat 专属 |
| `MAILAGENT_OPENNESS_SKILL_INSTALL` | `true`（Node + `_hot_bool`） | true | **翻 true** | skill 供应链 4 工具；**安全地板不变**：capability_change 安装恒 HITL、两段两卡、首跑闸 |
| `MAILAGENT_CUSTOM_AGENTS_ENABLED` | `true`（Node + pydantic） | true | **翻 true** | custom agent 内核 + 产品化；**per-agent 仍需 `report_agent.enabled` + type='custom' 才激活，on 不配 grant/规则 = 恒 HITL**（per-agent opt-in = 天然开关）。显式 false → hook/worker/端点/CRUD 工具全灭字节级回 S4 前 |
| `MAILAGENT_ISLAND_AGENT_ENABLED` | `true`（Node + pydantic alias） | userData true / 主仓缺（默认 false） | **翻 true（owner 终拍 2026-07-06）** | 无岛（Ping Island 未装/未跑）降级已验证优雅：fail-open 有直接单测、INFO 级 0 噪音、ack pending 有界自过期（≤500 行 30min TTL）、审批主链完全不受影响、agent 路径不入 reconnect 队列（见 [task research/island-no-island-degradation.md](../../../.trellis/tasks/07-06-e3-config-governance-flag-cutover/research/island-no-island-degradation.md)）。无岛用户翻 true = 无害空转（静默无功能，非报错）；有岛用户默认享受离岛 resume。显式 false → 字节级回退（guard 5min TTL、无 stash/announce） |

**安全地板不受默认翻转影响**：EXEC（无白名单恒 HITL）、SKILL_INSTALL（capability_change 恒 HITL）、WEB（外发恒人审）的 HITL 地板由工具 tool_class + 审批链决定，与「工具是否注册」正交。翻默认只是让工具默认可见，不放松任何审批。

---

## 2. 待定（验证进行中，本批不翻）

> ISLAND 已于同日（2026-07-06）终拍翻默认，见 §1。本节仅剩 `NOTION_READ_FROM_SQLITE` 观察窗口中。

| flag | 代码默认 | 生产实际 | 决策 | 依据 |
|---|---|---|---|---|
| `NOTION_READ_FROM_SQLITE` | `false`（pydantic） | 主仓 `.env` true / userData 从未开 | **观察窗口中，窗口结束后单独小 commit 拍板** | 真生产（.app userData `.env`）2026-07-06 起显式置 true 开观察窗口。判据 = sync/resync 正常、miss fallback 行为正确、无 Notion 读退化。**不阻塞 openness cutover 批**——独立于 openness，结论出来后单独翻或登记保留 |

---

## 3. 有意保留偏离（生产靠 `.env` 覆盖，代码默认不动）

| flag | 代码默认 | 生产实际 | 决策 | 理由 |
|---|---|---|---|---|
| `MAILAGENT_BACKEND` | `applescript`（pydantic） | davmail（`.env` 覆盖） | **保留偏离** | 打包 app 新用户默认 applescript = 零依赖零合规首发（无需 DavMail JVM / IT 审批），是产品决策；生产经 `.env` 切 davmail。见 CLAUDE.md「关键开关现状」表 ★ 标注 |

---

## 4. 有意保留默认 off（集成类，跟随用户配置启用）

这些 flag 依赖外部凭证 / 集成存在，默认开 = 报错或静默 no-op（KOS 有静默 no-op 前科）；属**部署配置**而非**灰度 flag**，代码默认 off 是正确的「零配置零副作用」姿态，用户配好凭证后自行开。

| flag | 代码默认 | 依赖 | 默认 off 理由 |
|---|---|---|---|
| `FEISHU_NOTIFY_ENABLED` | `false` | 飞书应用 token | 无 token → 开=报错 |
| `REDIS_EVENTS_ENABLED` | `false` | Redis + webhook | 无 Redis → 开=连接失败 |
| `ALERT_ENABLED` | `false` | 飞书告警机器人 | 同飞书 |
| `MAILAGENT_KOS_INGEST_ENABLED` | `false` | KOS OAuth 凭据 | 无凭据 → 静默 no-op（前科） |
| `MAILAGENT_KOS_CONSUMER_ENABLED` | `false` | KOS OAuth 凭据 | 同上 |
| `MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED` | `false` | KOS 集成 | 同上 |
| `MAILAGENT_KOS_INGEST_DRY_RUN` / `_TIME_DECAY_ENABLED` | 各自默认（dry_run false / time_decay true） | KOS 集成子项 | 随 KOS 总闸 |
| `LLM_AGENT_ENABLED` | `false` | 本地 LLM 服务 | 无本地 LLM → 开=分类失败；启用前须防双跑 |
| `CALENDAR_CALDAV_SYNC_ENABLED` | `false` | CalDAV（davmail） | 需 davmail 桥 + 用户 opt-in |
| `PROJECT_PROGRESS_SYNC_ENABLED` | `false` | xlsx 源 + Notion DB | 外挂 ETL，用户 opt-in |
| `MAILAGENT_REPORT_AGENT_ENABLED` | `false` | LLM + per-agent enabled | 报告 worker，per-agent 还需 `report_agent.enabled` |
| `SYNC_FOLDERS` | `[]`（空） | 用户选定 Exchange 文件夹 | 空 = 零激活 = 逐字节同现状 |

---

## 5. 已 GA / 已 cutover 的历史 flag 现状（简表，一行一个）

从 CLAUDE.md「关键开关现状」表整理，均已过灰度期、默认 true 或作 kill-switch，不属本批范围：

| flag | 现默认 | 性质 |
|---|---|---|
| `DRAFTS_SYNC_ENABLED` | `true` | GA（草稿箱同步） |
| `BODY_DUAL_WRITE_ENABLED` | `true` | GA（v4 双写） |
| `SEARCH_TRIGRAM_ENABLED` | `true` | GA（中文子串 FTS5） |
| `MAILAGENT_STANDING_CONTEXT_ENABLED` | `true` | GA（分层 prompt；env-only 热读，OFF 回退旧 SOUL） |
| `MAILAGENT_MEM0_CAPTURE` / `_RETRIEVAL` | `true` | 2026-07-02 cutover（memory.md 记忆） |
| `MAILAGENT_USER_MD_COMPILE` | `true` | 2026-07-02 cutover |
| `MAILAGENT_SKILL_SELF_MOUNT` | `true` | 2026-07-02 cutover（skill→tool 门控 kill-switch） |
| `MAILAGENT_STANDING_DOCS_EDITOR` | `true` | GA（身份文档编辑器显隐） |
| `MAILAGENT_AI_SDK_WRITE_TOOLS` | `true` | GA 后 kill-switch（写工具） |
| `MAILAGENT_AI_SDK_SEND_TOOL` | `true` | GA 后 kill-switch（真发 SMTP） |
| `PING_ISLAND_ENABLED` | `true` | GA（mail 通知 + reconnect loop；≠ ISLAND_AGENT） |

---

## 6. 变更纪律（改任一 flag 默认时）

1. 先更新本表对应行的「代码默认 / 决策 / 理由」。
2. 同步 `src/config.py`（pydantic）/ `ai_gateway_lifecycle.ts`（Node envBool）/ `chat.py`（`_hot_bool`）**所有承接该 flag 的载体**——多载体 flag 必须全部同翻。
3. 同步 CLAUDE.md「关键开关现状」表的默认列 + `.env.example` 示例值/prose。
4. 跑 `pytest tests/config`（T1-T5）：T3 守护 cutover 双侧默认一致，T4 守护 CLAUDE.md 表 ↔ 代码默认对账。任一红 = 漏了一侧。
