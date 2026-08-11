# Matters（事项）架构内核

> 常青参考。描述事项系统**现在如何工作**，不记录它是怎么演进到这里的（过程档在
> `.trellis/tasks/08-09-mailagent-matters-mvp-p0-p7/` 与 `docs/archive/`）。
> 改动事项的运行语义后，同步改这里。

**一句话**：事项把「一件要推进的事」变成第一类对象 —— 邮件/会议/文档作为**资料**挂在它下面，
干系人、行动项、当前状态摘要围绕它组织，一个跟进 Agent 定期观察并**提出**更新，由 owner 决定接受。

---

## 1. 结构红线（改任何东西前先读这条）

三个入口共用「事项 Agent」这一张脸，但**安全姿态不同，代码上不许合成一条路径**：

| 入口 | 运行形态 | owner 在环 | 天花板 |
|---|---|---|---|
| 创建带调研 / 定时跟进 | **headless run** | ❌ 不在 | 服务端强制 Observe+Assist：固定 5 工具 allowlist、不下发任何 `grant*` 键、产出必过人工提案评审 |
| 事项对话 | **交互式** | ✅ 在 | 与普通 chat 同级 |

合并的结果只有两种：要么对话被无谓砍成只读，要么无人值守的 run 拿到本不该有的写能力。

**天花板的强制点**（改动必须同时看这三处）：

- `frontend/src/ai-gateway/tools/policy.ts` — `matter_followup` 只放行 `read` + `artifact`，
  **必须排在通用放行分支之前**
- `src/matters/run_spec.py` — `MATTER_FOLLOWUP_ALLOWED_TOOLS` 固定 5 个工具；spec 里**不含**任何 grant 键
- `frontend/src/ai-gateway/agentRun.ts` — `deriveContextMode` 在 runKind 上短路，
  🔴 **必须保持块写法**：`tests/api/test_context_mode_consistency.py` 是**源码正则闸**，
  改成单行 return 会让另一张 trigger-kind 表的抽取器误红

「事项 Agent」只能是**身份 / 品牌层**，套在现有 run kind 之上。

---

## 2. 数据模型

主表 `matter`（`src/mail/sync_store.py` 的 `MATTER_TABLE_DDLS`），围绕它的从表：

| 表 | 作用 | 关键约束 |
|---|---|---|
| `matter` | 事项本体 | `public_id` 形如 `MAT-0001`；`version` 用于 CAS |
| `matter_item` | 行动项 / 决策 / 问题 / 里程碑 / 阻塞 / 笔记 | `checklist_json` 只允许 `kind='action'` 非空 |
| `matter_resource` | 事项 ↔ 资料的多对多 | 身份归一走 `resource_identity.normalize_resource_key`（**唯一写侧** `_upsert_resource`）|
| `matter_stakeholder` | 干系人 | `is_waiting_on` 会产生等待信号 |
| `matter_relation` | 事项之间的关系 | |
| `matter_event` | 时间线 / 审计 | 🔴 `ON DELETE CASCADE` —— 事项被永久删除时事件**一起没**，所以永久删除的审计落**日志**不落事件 |
| `matter_update` | Agent 的更新提案 | `review_status` 四态 |
| `matter_attention` | 关注信号（episode 语义）| 判据单源 `attention.py::_collect_facts` |
| `matter_tag` | 标签定义（名 / 颜色 / 形状）| `matter.tags_json` 仍是**字符串数组**引用 name |
| `matter_resource_rejection` | 资料建议的拒绝记忆 | 见 §5 |
| `matter_search_document` | 搜索投影 | `matter` 表本身**没有** `search_` 前缀列 |

**标签的两个维度**：颜色与形状彼此独立（同色靠形状区分，同形靠颜色区分）。
`tags_json` 里出现、但定义表没有的名字**不是孤儿** —— 读取时回退默认样式并照常可选可改；
过滤掉它们会让存量标签变成「看不见但还挂在事项上」。

**完成标志** `goal_checks_json`：`[{"t": str, "done": bool}]`。与 `description`（核心目标）
同权限 —— **只有 `actor.kind == user` 能写**，Agent 只能建议。勾满只提示可以推进到「已完成」，
**不自动改状态**：状态推进恒是用户的动作。

---

## 3. 触发器（四种，`src/matters/triggers.py` 是解析单源）

`matter.schedule_json` 这一列的**内容**是 v2 envelope，列名不改：

```json
{"v": 2, "triggers": [{"id": "mtr_ab12cd", "kind": "schedule", "enabled": true, "...": "..."}]}
```

老形状（单个 schedule 对象）在**读侧**惰性映射成单 entry，**不改写库**。

| kind | 判据 | 幂等键里的证据 |
|---|---|---|
| `schedule` | 复用 `src/agents/schedule_rule` 求值器（该模块**零改动**）| occurrence 时间 |
| `event` | 新增的 `matter_event` 行（新证据到达）| 触发它的 event id |
| `condition` | **open 状态**的 `matter_attention` 信号 | 信号 id + subject_key |
| `manual` | 不自动触发，只由「立即跟进」驱动 | — |

🔴 **两条硬约束**：

1. **per-trigger marker**：marker 键是 `matter.trigger.last_fire.{matter_id}.{trigger_id}`。
   两条 trigger 共用一个键时，先 fire 的会把 marker 推到未来，另一条**永远**被判成已跑过。
   **v1 单 trigger 行沿用旧键** `matter.schedule.last_fire.{id}` —— 换键等于「从没 fire 过」，
   升级瞬间会立刻补跑一次。
2. **单条 entry 坏掉只跳过它自己**，不牵连同一事项的其它 trigger。

**EVENT/CONDITION 的选项集刻意小于设计稿**：只收录能映射到既有判据的项。
设计画的「会议结束」（日历与事项零接线）与「超过 5 天无进展」（后端无此判据）**不做** ——
与其四个选项里两个永不触发，不如少给两个。`wait_overdue` 的 UI 文案按**真实阈值 7 天**写
（`attention.WAIT_OVERDUE_DAYS`），不按设计稿的 3 天。

**新建事项**默认 `agent_enabled=1` 且带一条默认排程（每 3 天 · 09:00）——
开关开着而没有排程 = 永远不跑 = 一个说谎的开关，两者必须一起给。
🔴 **存量事项不回填**：迁移只改建表默认，不 `UPDATE` 既有行。

> 改存储形状时，**「谁在读它」必须和「谁在写它」一起清点**。升 v2 那次，前端两处解析仍只认
> v1，会把 v2 行读成「没有排程」而新建事项默认就是 v2 —— 没有任何闸会红，只能靠 recon 发现。
> 现在解析收口在 `frontend/src/shared/components/matters/matterSchedule.ts`。

---

## 4. 跟进 run 的任务契约

`run_spec._task_contract()`：owner 在全局配置面写过就用他的，否则**逐字回落**代码里的
`_TASK_CONTRACT`。是**替换不是拼接**（拼接会让同一份准则出现两遍）。

- 存储 = `agent_config.db` 的 profile doc，doc name `matter_agent`。
- 🔴 **不进 `PROFILE_DOC_NAMES`** —— 那 4 份是恒注入每次对话的可信身份，把跟进任务契约塞进去
  会污染所有普通对话。镜像 `memory.md` 的既有先例。
- 🔴 **不进 `SEED_TEMPLATES`** —— 没有 seed 模板，「行内容为空」才能作为「跟随代码默认」的信号。
  于是「恢复默认」就是清空，以后默认文案升级能自动惠及没自定义过的用户，而不是被一份历史快照冻住。
- 事项级 `matter_instructions` 是在这份基底**之后追加**，不替换。

**配置面只做 prompt**。设计画的「8 个工具勾选」「授权级别三档」**不做**：它们在本仓是服务端
强制的，做成 UI 开关后用户勾了也不生效 = 又一个说谎的界面。配置面改为**如实陈述**由系统固定。

---

## 5. 智能关联

- **拒绝记忆**：建议被拒后，同证据不再重现。「实质新证据」= 持久锚点集（线程 id / 干系人邮箱 /
  匹配关键词 / 外扩理由）变化；指纹**显式排除**时间戳、随机 id、置信度，所以重复跑同一次检索
  绕不过拒绝，而真有新锚点时能重新建议。
- **重复候选**：四信号加权可解释（资料重叠 / 干系人重叠 / 语义 Jaccard / 30 天内邻近），
  每条带理由与证据。时间邻近**只在已有其它信号时**才加分 —— 否则「同期创建」会把无关事项凑成候选。
- **URL 抓取**：零自研 SSRF 防护，直接复用 `src/api/routers/web.py::_do_fetch`（有测试钉死调的就是它）。
- **创建带调研**：纯读端点产草案，**不写库**（有测试钉死）；标题走确定性推导，无 LLM 依赖。

---

## 6. 开关

| 开关 | 默认 | 说明 |
|---|---|---|
| `MAILAGENT_MATTERS_ENABLED` | 见 Labs | 事项域总闸；off = 导航项与端点全灭 |
| `MAILAGENT_MATTER_AGENT_ENABLED` | 见 Labs | 跟进 Agent（run / 排程 / 提案评审）|

两个 flag 都收在设置 → Labs。🔴 gateway 侧的 `fetchAgentRunSpec` / `createAgentSession`
两个 hook 必须同时看 `customAgentsEnabled || matterAgentEnabled` —— 只看前者会让关掉 custom
agents 时事项跟进 run 一并 404。

---

## 7. 运维

```bash
# 事项与信号的分布
sqlite3 "$DB" "SELECT status, COUNT(*) FROM matter WHERE deleted_at IS NULL GROUP BY status"
sqlite3 "$DB" "SELECT kind, state, COUNT(*) FROM matter_attention GROUP BY kind, state"

# 待评审提案
sqlite3 "$DB" "SELECT matter_id, COUNT(*) FROM matter_update WHERE review_status='pending' GROUP BY matter_id"

# 某事项的触发器配置（v1 单对象 / v2 envelope 都可能）
sqlite3 "$DB" "SELECT public_id, agent_enabled, schedule_json FROM matter WHERE public_id='MAT-0001'"

# 触发器的 last-fire marker
sqlite3 "$DB" "SELECT key, value FROM sync_state WHERE key LIKE 'matter.%last_fire%'"
```

🔴 **活库在 userData 不在仓库 `data/`**：
`~/Library/Application Support/mailagent-frontend/data/sync_store.db`。

---

## 8. 跨语言一致性闸

| 闸 | 管什么 |
|---|---|
| `tests/matters/test_matters_contract_parity.py` | 枚举常量数组（TS `as const` vs Python canonical values）+ SQL CHECK 值集 + chat_config flag 投影。**不管** `MattersApi` 这个纯前端接口的方法列表 |
| `frontend/tests/shared/matterEventLocale.test.ts` | 两份 locale 覆盖 `MATTER_EVENT_KINDS` 全集。kind 数量会随功能增长，所以判据是**从 events.py 抽全集**，不是写死的数字；闸自身也断言「抽不到就红」 |
| `tests/api/test_context_mode_consistency.py` | `deriveContextMode` 的源码形状（正则闸，见 §1）|
| `frontend/tests/components/matters/matterSchedule.test.ts` | 排程解析两种形状都认 |
