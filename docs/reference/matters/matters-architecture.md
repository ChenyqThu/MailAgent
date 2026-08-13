# Matters（事项）架构内核

> 常青参考。描述事项系统**现在如何工作**，不记录它是怎么演进到这里的（过程档在
> `.trellis/tasks/08-09-mailagent-matters-mvp-p0-p7/` 与 `docs/archive/`）。
> 改动事项的运行语义后，同步改这里。

**一句话**：事项把「一件要推进的事」变成第一类对象 —— 邮件/会议/文档作为**资料**挂在它下面，
干系人、行动项、当前状态摘要围绕它组织，一个跟进 Agent 定期观察并**提出**更新，由 owner 决定接受。

---

## 1. 结构红线（改任何东西前先读这条）

三条入口共用「事项 Agent」这一张脸，但**安全姿态不同，代码上不许合成一条路径**：

| 入口 | 运行形态 | owner 在环 | 天花板 |
|---|---|---|---|
| 创建带调研 | **纯读端点**（`POST /api/matters/create-draft`，`create_research.py`）| ✅ 在（产的是草案，用户按下创建才落库）| 无 LLM run：确定性推导 + 邮件/Notion 检索，**一个字不写库** |
| 定时 / 立即跟进 | **headless run**（`runKind='matter_followup'`）| ❌ 不在 | 服务端按 **class** 强制 Observe+Assist：只读工具面 + 唯一提案通道，产出必过人工评审 |
| 事项对话 | **交互式** | ✅ 在 | 与普通 chat 同级 |

合并的结果只有两种：要么对话被无谓砍成只读，要么无人值守的 run 拿到本不该有的写能力。

### 1.1 跟进 run 的天花板：**按 class，不按名单**

0812 owner 拍板前，天花板是 Python 侧手抄的 5 个工具名（`MATTER_FOLLOWUP_ALLOWED_TOOLS`）。
那份常量**已退役**（全仓 grep 为空）。现在的判据是工具的 **policy class**：

| class | 跟进 run | 说明 |
|---|---|---|
| `read` | ✅ **全部放行** | run 的全部意义就是发现**新**证据，所以它读整个库，不受事项已关联的资料范围限制 |
| `artifact` | ⚠️ **只放行一个名字** | `MATTER_RUN_PROPOSE_TOOL`（`matter_update_propose`）。🔴 按名不按类 —— `report_write` 同属 artifact 但它是本地写，整类放行是个洞 |
| `web` | ⚠️ 由 spec 的 `grantWeb` + owner 的三档共同决定 | 见 §1.2 |
| `domain_write` / `connector_write` / `exec` / `capability_change` / `outbound` | ❌ 一律拒 | 🔴 **grant 与场地开关一概不查**：把事项绑到一个授了 `grant_exec` / connector 写权的 Agent Profile 上，也**永远**放不宽这张脸 —— profile 只贡献 model / persona（D2）|

**两道彼此独立的腰带**（改动必须同时看，最终 ToolSet 是两者的**交集**）：

1. `frontend/src/ai-gateway/tools/policy.ts` — `matter_followup` 矩阵行，
   **必须排在通用放行分支之前**（下一行 `read || domain_write || artifact → true` 会放过域写）；
2. `frontend/src/ai-gateway/agentRun.ts` — `wrapCfgForAgentRun` 的 read-face 豁免。

**spec 侧**（`src/matters/run_spec.py`）配套三条纪律：

- `allowedTools` **恒 `[]`** —— 名单交集已被 read-face 豁免取代；置空同时把
  「`chat_session_list ∈ allowedTools` = 全史 / `agent_catalog` grant 的代理」这类**旁路语义**一并关死
  （跟进 run 只看得到自己 agent 的会话历史）。
- `grantWeb` = `'open'`、`grantConnectors` 仅在配置了 connector 时投影且值恒 `'read'` ——
  这两个是**本函数唯一的授权来源**，绑定 profile 的 grants 一个键都不抄。
- 🔴 `grantExec` **永不写**。

**实际拿得到的工具面 = 31 件**（说明书单源 `frontend/src/shared/lib/matterToolFace.ts`，
按分组渲染在全局配置弹窗里）：28 件只读 + 1 件提案 artifact + 2 件网页（受三档约束），
另加 connector 只读工具（`mcp__*`，运行时按已连接的家动态注册，不在任何静态清单里）。

🔴 read class 共 31 件，但有 **3 件结构上到不了**跟进 run，说明书**有意不列**（列了闸就红）：
`suggest_followups`（另有 manual_chat 场地门）、`agent_catalog_list` / `agent_catalog_get`
（注册条件是 `allowedTools` 含 `chat_session_list`，而 matter spec 恒 `[]`）。

### 1.2 网页三档 `matter_run_web_face`

无人值守 + 能出网 = 无审批的数据外传通道，所以单给了一档 owner 可配的收窄旋钮
（`owner_settings`，非 env；`GET/PUT /api/agent/matter-web-face`）：

| 档 | 效果 |
|---|---|
| `keep`（默认）| 矩阵放行的 `web_search` + `web_fetch` 都活 |
| `search_only` | 腰带砍掉 `web_fetch`（URL 编码外传通道），只留检索 |
| `off` | 不管 spec 写没写 `grantWeb`，整个 web class 都不给 |

🔴 **fail-safe 是 `keep` 不是 `off`**：一次瞬时的 DB / loopback 读失败不该静默砍掉无人值守
run 的上网能力 —— owner 永远看不见这件事发生。反过来，**越域值一律 400 不静默回落**：
静默回落会让「UI 显示的档」与「实际生效的档」劈叉，在一个安全档上这比报错危险得多。
run 起始解析一次并冻进 run context，pause / resume 复用同值。

### 1.3 matter 工具家族本身（13 件）

`MAILAGENT_MATTERS_ENABLED` 门控、all-or-nothing：2 读（`matter_find` / `matter_get`）+
9 写（`matter_create` / `matter_update` / 四个 `*_mutate` / `matter_add_note` /
`matter_run_control` / `matter_review_update`）+ 1 提案 artifact（`matter_update_propose`，
**只在 matter-run 语境注册**）+ `matter_suggest_related_resources`。

🔴 最后这件**有意不在 `GATEWAY_TOOL_CLASSES` 里**（明确裁定，不是漏登记）：它是 manual-chat
专属的供给型工具，两道腰带是 `tools/index.ts` 的 `contextMode === 'manual_chat'` 注册门 +
`classOfTool` 未命中时 fail-closed 兜底成 `'exec'`（matter 腰带拒 exec）。代价是
`policy.test.ts` 的 class 同步闸**结构上覆盖不到它** —— 动它的注册条件时没有闸兜底。

**全 13 件都带 `headless_excluded`**：普通 custom-agent 的 headless run（`untrusted_trigger` /
`cron_headless`）**一件 matter 工具都拿不到**，连读面也没有 —— 不出现在能力勾选面上 =
结构性不可达。但除 `matter_suggest_related_resources` 外的 12 件**在 `im_chat` 里照常注册**
（owner 在场），所以给它们标 `manual_only` 是语义错的；只有 suggest 那件真是 manual-only。

🔴 `headless_excluded` 说的是「不出现在 custom-agent 的能力勾选面上」，**与跟进 run 的工具面
无关** —— 后者按 class 推导（§1.1），从不看 `HEADLESS_TOOL_OPTIONS`。

### 1.4 context mode 的源码形状

`frontend/src/ai-gateway/agentRun.ts` 的 `deriveContextMode` 在 `runKind` 上短路，
🔴 **必须保持块写法**：`tests/api/test_context_mode_consistency.py` 是**源码正则闸**，
改成单行 return 会让另一张 trigger-kind 表的抽取器误红。

「事项 Agent」只能是**身份 / 品牌层**，套在现有 run kind 之上。

---

## 2. 数据模型

主表 `matter`（`src/mail/sync_store.py` 的 `MATTER_TABLE_DDLS`），围绕它的从表。
迁移占用 `DB_VERSION` **v44–v50**（v44/v45 基表与资源域 · v46 run 账本 · v47 attention ·
v48 email/thread external_key 归一 · v49 拒绝记忆 · v50 标签定义表 + 完成标志）：

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

每轮 task prompt 的拼装顺序（`run_spec.py`）：任务契约 → 本轮可做的动作（由 `schedule_json` 推）
→ 上下文快照 → 变更清单（watermark diff）→【补充指引】（profile persona + 事项级指引，套
`PERSONA_PREFIX` 围栏）。

### 4.1 全局配置面呈现什么

入口有两个，指向**同一个弹窗**（`MatterGlobalAgentModal`）：设置 → 事项（深链）、
事项详情 → Agent 配置 →「全局配置」。🔴 设置页**只做深链不复制表单** —— 同一份数据画两个可写面
就是第二处真相（`/connectors` 收编内置工具审批档时踩过同一条线）。

弹窗自上而下三块：

1. **Prompt 装配说明**（只读）—— 每轮 prompt 由哪几段拼成、你改的是哪一段；
2. **任务契约编辑框** —— 唯一可改的那一段（库里空 = 跟随代码默认，见上）；
3. **工具面板** —— 31 件逐项列出 + 唯一可改的网页三档。

设计稿画的「8 个可用工具勾选」**不做**：那 31 件是服务端按 class 强制推导的（§1.1），
勾选框勾不掉也勾不上 —— 画出来就是假开关。改为**列出来 + 标明哪些固定**；真正可配的只有
网页那一档（`matter_run_web_face`，服务端确实读它），它才做成真开关。

🔴 **`fixed` ≠「一定拿得到」**：带 `skill` 的分组（email / search / report）受 skill 门控 ——
owner 在 设置 → Custom AI → Skills 关掉某个 skill，跟进 run 真的一件都拿不到。`fixed` 说的是
「**事项级**不可改」，不是「全局关不掉」。界面必须按 `advertisedSkills` 把关掉的那组标出来，
否则又是一句谎；🔴 投影没回来时 **fail-open 判可用** —— 把「不知道」说成「关了」同样是撒谎。

---

## 5. 智能关联

- **拒绝记忆**：建议被拒后，同证据不再重现。「实质新证据」= 持久锚点集（线程 id / 干系人邮箱 /
  匹配关键词 / 外扩理由）变化；指纹**显式排除**时间戳、随机 id、置信度，所以重复跑同一次检索
  绕不过拒绝，而真有新锚点时能重新建议。
- **重复候选**：四信号加权可解释（资料重叠 / 干系人重叠 / 语义 Jaccard / 30 天内邻近），
  每条带理由与证据。时间邻近**只在已有其它信号时**才加分 —— 否则「同期创建」会把无关事项凑成候选。
- **URL 抓取**：零自研 SSRF 防护，直接复用 `src/api/routers/web.py::_do_fetch`（有测试钉死调的就是它）。
- **创建带调研**：纯读端点产草案，**不写库**（有测试钉死）；标题走确定性推导，无 LLM 依赖。
- **手动关联的候选**（`GET /{id}/resource-candidates`，只读）与 Agent 建议**共用同一个候选引擎**
  `_email_resource_candidates` —— 于是人工挑与 Agent 建议看到的是同一批锚点、同一套理由文案，
  不会出现「Agent 说相关的这封，我自己搜却看不到」。差别只有一个：这里一个字都不写
  （不建 link、不发事件、不推版本、不吃 backlog 配额），所以**打开弹窗本身没有副作用**。
  🔴 有意**不接** `query` / `expand_reason`：`local` 档结构上要求线程 / 干系人硬锚，关键词只能
  加分。用户在弹窗里输的关键词走的是另一条路 —— 前端的全局邮件搜索（FTS5）。
- **本事项邮件附件**（`GET /{id}/resource-attachments`，只读）：🔴 **一条 SQL 拿全部** ——
  逐封扇出 `attachment/list/{internal_id}` 在挂了几十封邮件的事项上就是几十个请求
  （`frontend/ARCHITECTURE.md` §7.1 列表性能铁律）。`is_inline=0`：正文里的 cid 图片不是「资料」。
- 🔴 **干系人「往来候选」依赖 email resource 的 `sender` / `to_addr` / `cc_addr` metadata**，
  这三个键 0812 起才在两条生产路径上产出 —— **存量 `matter_resource` 行结构性为空**，
  那些事项的往来候选是空的（靠手输兜底），不回填。

---

## 6. 开关

**env flag 两个**（改后需重启后端 / app）：

| 开关 | 默认 | 载体 | 说明 |
|---|---|---|---|
| `MAILAGENT_MATTERS_ENABLED` | **true**（2026-08-12 cutover）| 四份：`src/config.py` · `ai_gateway_lifecycle.ts` · `matter_notifications.ts` · `.env.example` | 事项域总闸。显式 false = 导航项不渲染 + `/api/matters/*` 全 403 + gateway matter 工具家族不注册 |
| `MAILAGENT_MATTER_AGENT_ENABLED` | **false** | 双份（Python + Node）| 跟进 Agent（runs / propose 端点 + `matter_followup` worker 分派 + spec assembler）。有意保持关：无人值守 + 有网络出口。off 时 updates / review REST 仍可用（清账既有 pending 提案）|

语义是 **AND**：总闸 off 时第二个 flag 无意义（router 全 403 在前）。

两个 flag 都收在设置 → Labs。🔴 `MAILAGENT_MATTERS_ENABLED` 已 cutover 默认 ON 却**仍留在
Labs**，是对「Labs 只收默认 OFF 的灰度 flag」的**有意例外** —— 它没有第二个关它的界面，
照字面撤条目会把唯一的应急回退开关删掉。撤之前先给它一个正式落点。

🔴 gateway 侧的 `fetchAgentRunSpec` / `createAgentSession` 两个 hook 必须同时看
`customAgentsEnabled || matterAgentEnabled` —— 只看前者会让关掉 custom agents 时事项跟进 run
一并 404。

**owner 设置两项**（`agent_config.db` 的 `owner_settings`，**不是 env**，保存即生效）：

| 键 | 默认 | 值域 | 端点 |
|---|---|---|---|
| `matter_run_web_face` | `keep` | `keep` \| `search_only` \| `off` | `GET/PUT /api/agent/matter-web-face`，语义见 §1.2 |
| `matter_notify_level` | `high` | `high` \| `all` \| `off` | `GET/PUT /api/matters/notify-level`；越域 400，worker 侧再归一一次 |

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
| `frontend/tests/ai-gateway/matter_tool_face_leaf.test.ts` | **工具面说明书 ↔ 真实 ToolSet 双向**：(a) 表里每个名字都真的在工具面里（无幽灵条目）；(b) 工具面里每个名字都落在某个分组里（无藏起来的能力）；(c) 关掉一个 skill 后真实消失的那批 == 叶子里标了该 skill 的那批。跑的是真实 `runHeadlessAgent` + `buildGatewayTools`，不是另一份手抄名单 |
| `tests/config/test_matter_web_face_parity.py` | 网页三档词表 + 缺省值的**三份手抄**（Python 端点 / gateway policy.ts / renderer hook）。🔴 renderer 那份漂了 **typecheck 不会红**（`readonly MatterRunWebFace[]` 装子集合法），只能靠这道闸 |
| `frontend/tests/shared/matterEventLocale.test.ts` | 两份 locale 覆盖 `MATTER_EVENT_KINDS` 全集。kind 数量会随功能增长，所以判据是**从 events.py 抽全集**，不是写死的数字；闸自身也断言「抽不到就红」 |
| `tests/matters/test_matter_trigger_envelope_parity.py` | trigger v2 envelope 的跨语言形状 |
| `tests/api/test_context_mode_consistency.py` | `deriveContextMode` 的源码形状（正则闸，见 §1.4）|
| `frontend/tests/components/matters/matterSchedule.test.ts` | 排程解析两种形状都认 |
